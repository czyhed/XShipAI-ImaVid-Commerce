"""Add an isolated Shangjing instance to /opt/xshipai-test; never touch other stacks."""
from pathlib import Path
import base64, datetime, json, os, secrets, shutil, subprocess, time

root = Path('/opt/xshipai-test')
os.chdir(root)
os.umask(0o077)
def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)
def dc(*args, **kwargs):
    return run('docker', 'compose', '-f', 'compose.json', *args, **kwargs)

backup = root/'backups'/('shangjing-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.mkdir(parents=True)
shutil.copy2(root/'compose.json', backup/'compose.json')
shutil.copy2(root/'config/gateway.conf', backup/'gateway.conf')
private = root/'config/shangjing.private.json'
if private.exists():
    keys = json.loads(private.read_text())
else:
    keys = {name: secrets.token_hex(24) for name in ['database', 'objects']}
    keys['encryption'] = base64.b64encode(secrets.token_bytes(32)).decode()
    private.write_text(json.dumps(keys)); private.chmod(0o600)

tls = root/'config/shangjing-tls'; tls.mkdir(exist_ok=True)
tls.chmod(0o755)
if not (tls/'ca.crt').exists():
    run('openssl','req','-x509','-newkey','rsa:3072','-nodes','-days','3650','-keyout',str(tls/'ca.key'),'-out',str(tls/'ca.crt'),'-subj','/CN=XShipAI Shangjing Internal CA',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
for name, uid in [('shangjing-db',999),('shangjing-objects',0)]:
    folder=tls/name; folder.mkdir(exist_ok=True); folder.chmod(0o755)
    if not (folder/'public.crt').exists():
        run('openssl','req','-newkey','rsa:2048','-nodes','-keyout',str(folder/'private.key'),'-out',str(folder/'request.csr'),'-subj','/CN='+name,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        (folder/'extensions').write_text('subjectAltName=DNS:'+name+',DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
        run('openssl','x509','-req','-in',str(folder/'request.csr'),'-CA',str(tls/'ca.crt'),'-CAkey',str(tls/'ca.key'),'-CAcreateserial','-days','825','-extfile',str(folder/'extensions'),'-out',str(folder/'public.crt'),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    (folder/'public.crt').chmod(0o644); (folder/'private.key').chmod(0o600)
    os.chown(folder/'private.key',uid,uid)
(tls/'ca.crt').chmod(0o644)

def envfile(name, values):
    p=root/'config'/name
    p.write_text(''.join(k+'='+str(v)+'\n' for k,v in values.items()));p.chmod(0o600)
envfile('shangjing-db.env',{'POSTGRES_USER':'shangjing','POSTGRES_PASSWORD':keys['database'],'POSTGRES_DB':'shangjing'})
envfile('shangjing-objects.env',{'MINIO_ROOT_USER':'shangjing','MINIO_ROOT_PASSWORD':keys['objects']})
envfile('shangjing.env',{
    'PORT':'4173','SJ_LISTEN_HOST':'0.0.0.0','SJ_ALLOWED_HOSTS':'23.144.68.140:18186',
    'SJ_PUBLIC_ORIGIN':'http://23.144.68.140:18186','SJ_AUTH':'off',
    'PGHOST':'shangjing-db','PGDATABASE':'shangjing','PGUSER':'shangjing','PGPASSWORD':keys['database'],
    'MIDDLEWARE_CA_CERT':'/run/shangjing/ca.crt','MINIO_ENDPOINT':'https://shangjing-objects:9000',
    'MINIO_ACCESS_KEY':'shangjing','MINIO_SECRET_KEY':keys['objects'],
    'MINIO_BUCKET_ASSETS':'shangjing-assets','MINIO_BUCKET_EXPORTS':'shangjing-exports',
    'CHANNEL_ENCRYPTION_KEY':keys['encryption']})
compose=json.loads((root/'compose.json').read_text())
common={'restart':'unless-stopped','logging':{'driver':'json-file','options':{'max-size':'10m','max-file':'3'}},'security_opt':['no-new-privileges:true']}
compose['services']['shangjing-db']={**common,'image':'postgres:17','env_file':['./config/shangjing-db.env'],
    'volumes':['shangjing-db:/var/lib/postgresql/data','./config/shangjing-tls/shangjing-db:/run/tls:ro'],
    'command':['postgres','-c','ssl=on','-c','ssl_cert_file=/run/tls/public.crt','-c','ssl_key_file=/run/tls/private.key'],
    'healthcheck':{'test':['CMD-SHELL','pg_isready -U shangjing -d shangjing'],'interval':'5s','timeout':'3s','retries':12}}
compose['services']['shangjing-objects']={**common,'image':'minio/minio:RELEASE.2025-10-15T17-29-55Z',
    'env_file':['./config/shangjing-objects.env'],'command':['server','/data','--certs-dir','/run/tls'],
    'volumes':['shangjing-objects:/data','./config/shangjing-tls/shangjing-objects:/run/tls:ro']}
image='xshipai/shangjing:'+os.environ['APP_IMAGE_TAG'] if os.environ.get('APP_IMAGE_TAG') else compose['services'].get('shangjing',{}).get('image')
if not image:raise SystemExit('APP_IMAGE_TAG is required for first install')
compose['services']['shangjing']={**common,'image':image,
    'env_file':['./config/shangjing.env'],'volumes':['./config/shangjing-tls/ca.crt:/run/shangjing/ca.crt:ro'],
    'depends_on':{'shangjing-db':{'condition':'service_healthy'},'shangjing-objects':{'condition':'service_started'}},
    'mem_limit':'1g'}
for name in ['shangjing-db','shangjing-objects']:compose.setdefault('volumes',{}).setdefault(name,{})
(root/'compose.json').write_text(json.dumps(compose,indent=2))
dc('up','-d','shangjing')
for _ in range(30):
    r=subprocess.run(['docker','compose','-f','compose.json','exec','-T','shangjing','node','-e',"fetch('http://127.0.0.1:4173/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if r.returncode==0:break
    time.sleep(2)
else:raise SystemExit('Shangjing did not become ready; inspect container logs')
dc('exec','-T','shangjing','node','--input-type=module','-e',"import {createMinioClient} from './server/store.mjs';const {client}=createMinioClient();for(const b of ['shangjing-assets','shangjing-exports'])if(!await client.bucketExists(b))await client.makeBucket(b);console.log('Private storage ready')")
print('Shangjing is ready on the private network; backup:',backup)
