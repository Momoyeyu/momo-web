import json, sys, urllib.request
import websocket
command = json.load(sys.stdin)
pages = json.load(urllib.request.urlopen('http://127.0.0.1:9222/json'))
ws = websocket.create_connection(next(p['webSocketDebuggerUrl'] for p in pages if p['type']=='page'),origin='http://localhost')
seq = 0
def call(method, params={}):
    global seq
    seq += 1
    ws.send(json.dumps(dict(id=seq,method=method,params=params)))
    while True:
        response=json.loads(ws.recv())
        if response.get('id')==seq:
            if 'error' in response: raise RuntimeError(response['error']['message'])
            return response.get('result',{})
call('Emulation.setScriptExecutionDisabled',{'value':True})
call('Emulation.setDeviceMetricsOverride',dict(width=1024,height=768,deviceScaleFactor=1,mobile=False))
action=command['action']
if action=='load':
    html=command['html']
    if not isinstance(html,str) or len(html)>100000: raise ValueError('HTML budget')
    tree=call('Page.getFrameTree')
    call('Page.setDocumentContent',dict(frameId=tree['frameTree']['frame']['id'],html=html))
elif action in ('elementClick','elementFill'):
    backend=command['backendNodeId']
    if not isinstance(backend,int) or backend<1: raise ValueError('Invalid element')
    if action=='elementFill':
        value=command['text']
        if not isinstance(value,str) or len(value)>1000: raise ValueError('Text budget')
        call('DOM.focus',{'backendNodeId':backend})
        call('Input.dispatchKeyEvent',dict(type='keyDown',key='a',code='KeyA',windowsVirtualKeyCode=65,modifiers=2))
        call('Input.dispatchKeyEvent',dict(type='keyUp',key='a',code='KeyA',windowsVirtualKeyCode=65,modifiers=2))
        call('Input.insertText',dict(text=value))
    else:
        call('DOM.scrollIntoViewIfNeeded',{'backendNodeId':backend})
        quad=call('DOM.getBoxModel',{'backendNodeId':backend})['model']['content']
        x,y=sum(quad[::2])/4,sum(quad[1::2])/4
        if not 0<=x<1024 or not 0<=y<768: raise ValueError('Element outside viewport')
        for kind in ('mousePressed','mouseReleased'):
            call('Input.dispatchMouseEvent',dict(type=kind,x=x,y=y,button='left',clickCount=1))
elif action=='click':
    x,y=command['x'],command['y']
    if not 0<=x<1024 or not 0<=y<768: raise ValueError('Coordinates outside viewport')
    for kind in ('mousePressed','mouseReleased'):
        call('Input.dispatchMouseEvent',dict(type=kind,x=x,y=y,button='left',clickCount=1))
elif action=='type':
    value=command['text']
    if not isinstance(value,str) or len(value)>1000: raise ValueError('Text budget')
    call('Input.insertText',dict(text=value))
elif action=='scroll':
    delta=max(-768,min(768,int(command['delta'])))
    call('Input.dispatchMouseEvent',dict(type='mouseWheel',x=512,y=384,deltaX=0,deltaY=delta))
elif action not in ('observe','inspect'): raise ValueError('Unsupported action')
result=call('Page.captureScreenshot',dict(format='png'))
if action=='inspect':
    nodes=call('Accessibility.getFullAXTree')['nodes']
    elements=[]
    for node in nodes:
        if node.get('ignored') or not node.get('backendDOMNodeId'): continue
        role=str(node.get('role',{}).get('value',''))[:40]
        if role in ('none','generic','InlineTextBox'): continue
        name=str(node.get('name',{}).get('value',''))[:160]
        elements.append({'backendNodeId':node['backendDOMNodeId'],'role':role,'name':name})
        if len(elements)>=60: break
    result['elements']=elements
    result['untrusted']=True
print(json.dumps(result))
ws.close()
