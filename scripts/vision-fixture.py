"""Deterministic image-content reader for isolated browser tests, NOT a model.

Recognizes only generated numeric challenge tiles or the dominant RGB swatch.
It deliberately reads bytes rather than returning success for ignored images.
"""
import base64,io,json,sys
from PIL import Image,ImageDraw,ImageFont,ImageChops
value=json.load(sys.stdin)
images=[part for m in value['messages'] if isinstance(m.get('content'),list) for part in m['content'] if part.get('type')=='image_url']
image=Image.open(io.BytesIO(base64.b64decode(images[-1]['image_url']['url'].split(',')[1]))).convert('RGB')
if not value['stream']:
    assert image.size==(360,100)
    digits=[];font=ImageFont.load_default(size=55)
    for index in range(6):
        x=25+50*index;tile=image.crop((x,0,x+50,100));scores=[]
        for digit in '23456789':
            expected=Image.new('RGB',(50,100),'white');ImageDraw.Draw(expected).text((0,12),digit,fill='black',font=font)
            diff=ImageChops.difference(tile,expected);scores.append((sum(sum(v) for v in diff.getdata()),digit))
        score,digit=min(scores);assert score==0;digits.append(digit)
    print(''.join(digits))
else:
    rgb=image.resize((1,1)).getpixel((0,0));print(['red','green','blue'][max(range(3),key=lambda i:rgb[i])])
