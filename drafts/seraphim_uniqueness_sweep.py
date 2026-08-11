
from PIL import Image
import numpy as np, json, os, hashlib
RUN = os.path.expanduser("~/openagi/cerberus/sprites/runtime")
m = json.load(open(os.path.join(RUN,"atlas.json")))
CELL = m["cell"]
def cell(atlas, fd, name):
    s = fd["frames"][name]; sx=(s%fd["cols"])*CELL; sy=(s//fd["cols"])*CELL
    return np.array(atlas.crop((sx,sy,sx+CELL,sy+CELL)).convert("RGBA"))
LIM = {"idle":10,"alert":25,"working":25,"attack":25,"victory":25,"sleep":10,"walk":25}
allok=True
for form in ["omega","alpha"]:
    fd=m["forms"][form]
    p=os.path.join(RUN,f"{form}_atlas.png")
    atlas=Image.open(p)
    real_sha=hashlib.sha256(open(p,'rb').read()).hexdigest()[:12]
    print(f"== {form} == claimed sha={fd['sha']} actual={real_sha} match={fd['sha']==real_sha} size={atlas.size} totalframes={len(fd['frames'])}")
    for st,spec in fd["states"].items():
        seq=spec["seq"]; imgs=[cell(atlas,fd,n) for n in seq]
        hashes=[hashlib.md5(a.tobytes()).hexdigest() for a in imgs]
        uniq=len(set(hashes))
        chgs=[]
        for i in range(len(imgs)):
            a,b=imgs[i],imgs[(i+1)%len(imgs)]
            u=(a[:,:,3]>0)|(b[:,:,3]>0)
            d=(a[:,:,:3]!=b[:,:,:3]).any(axis=2)|(a[:,:,3]!=b[:,:,3])
            chgs.append(100.0*d[u].sum()/max(1,u.sum()))
        mx,mn=max(chgs),min(chgs)
        # motion floor: is there ACTUALLY visible animation?
        motion = "DEAD" if mx < 0.5 else ("faint" if mx < 2.0 else "ok")
        ok = mx<=LIM.get(st,10) and uniq==len(seq) and mx>=0.5
        allok&=ok
        print(f"  {st:8} n={len(seq):2} uniq={uniq:2} chg {mn:5.2f}-{mx:5.2f}% gate={LIM.get(st,10)} motion={motion} -> {'PASS' if ok else 'FAIL'}")
print("INDEPENDENT:", "ALL PASS" if allok else "FAIL")
