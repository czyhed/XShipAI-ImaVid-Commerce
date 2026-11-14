"""Exercise the deployed gateway, persisted records and private media; no paid calls."""
import http.client, json, os, struct, zlib
from urllib.parse import quote

cookie=''
def request(port,path,method='GET',body=None,headers=None):
    conn=http.client.HTTPConnection('127.0.0.1',port,timeout=30)
    raw=body if isinstance(body,bytes) else json.dumps(body).encode() if body is not None else None
    conn.request(method,path,raw,{'Host':f'23.144.68.140:{port}','Origin':f'http://23.144.68.140:{port}',
        'Cookie':cookie,'Content-Type':'application/json',**(headers or {})})
    r=conn.getresponse();result=(r.status,dict(r.getheaders()),r.read());conn.close();return result
def api(path,body=None,headers=None):
    status,_,raw=request(18186,path,'POST' if body is not None else 'GET',body,headers)
    assert status in (200,201),(path,status)
    return json.loads(raw)

assert request(18186,'/api/model-hub')[0]==303
status,head,_=request(18180,'/api/login','POST',{'username':'xshipai','password':os.environ['DESKTOP_PASSWORD']})
assert status==200
cookie=head['Set-Cookie'].split(';')[0]
session=json.loads(request(18180,'/api/session')[2])
assert request(18186,'/')[0]==303
assert request(18180,'/api/launch/shangjing','POST',{}, {'X-CSRF-Token':session['csrf']})[0]==200
try:
    status,head,html=request(18186,'/')
    assert status==200 and b'<div id="root">' in html
    assert "frame-ancestors http://23.144.68.140:18180" in head['Content-Security-Policy']
    assert "frame-ancestors 'none'" not in head['Content-Security-Policy']
    app_session=api('/api/session');csrf={'X-CSRF-Token':app_session['csrfToken']}
    for path in ['/api/creation/overview','/api/creation/products','/api/creation/projects','/api/creation/assets','/api/model-hub']:
        api(path);print(path+': OK')
    assert request(18186,'/api/creation/projects','POST',{})[0]==403
    assert request(18186,'/api/creation/projects','POST',{},csrf|{'Origin':'https://example.invalid'})[0]==403
    name='部署测试色卡（非商品图片）'
    assets=api('/api/creation/assets?q='+quote(name))['items']
    if assets: asset=assets[0]
    else:
        def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
        raw=b''.join(b'\x00'+b''.join(bytes([x*4,130,y*4]) for x in range(64)) for y in range(64))
        png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',64,64,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
        asset=api('/api/creation/assets/upload?name='+quote(name)+'&mime=image/png',png,csrf|{'Content-Type':'image/png'})['asset']
    status,_,data=request(18186,asset['fileUrl']);assert status==200 and data.startswith(b'\x89PNG')
    status,_,part=request(18186,asset['fileUrl'],headers={'Range':'bytes=0-7'});assert status==206 and part==data[:8]
    print('Private media upload/read/range OK; sample retained:',asset['id'])
finally:
    assert request(18180,'/api/logout','POST',{}, {'X-CSRF-Token':session['csrf']})[0]==200
assert request(18186,'/api/creation/projects')[0]==303
assert request(18186,asset['fileUrl'])[0]==303
print('Logout revokes data and media access')
