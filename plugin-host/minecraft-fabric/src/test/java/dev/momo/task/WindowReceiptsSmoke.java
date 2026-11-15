package dev.momo.task;
public final class WindowReceiptsSmoke {
 public static void main(String[] args){
  var ledger=new InventoryReceipts();Object world=new Object(),other=new Object(),screen=new Object();long before=ledger.cursor();
  if(ledger.windowAfter(world,screen,before)!=null)throw new AssertionError("a client menu cannot fabricate a server open receipt");
  ledger.recordWindow(world,screen,"block:1,2,3",0);
  var opened=ledger.windowAfter(world,screen,before);
  if(opened==null||!opened.target().equals("block:1,2,3")||opened.handler()!=0)throw new AssertionError("non-container sign UI retains its actual server target");
  if(ledger.windowAfter(world,new Object(),before)!=null||ledger.windowAfter(world,screen,opened.sequence())!=null)throw new AssertionError("old or different window identities cannot acknowledge a new dispatch");
  ledger.recordWindow(world,screen,"entity:42",7);
  if(!ledger.windowAfter(world,screen,opened.sequence()).target().equals("entity:42"))throw new AssertionError("horse inventory has the actual entity identity from its packet");
  var request=ledger.requestWindow(world,"entity:42",1000);
  if(ledger.confirmedWindow(request,world,screen,7,1001))throw new AssertionError("an old horse screen cannot acknowledge a new inventory request");
  ledger.recordWindow(world,screen,"entity:41",8);
  if(ledger.confirmedWindow(request,world,screen,8,1002))throw new AssertionError("another horse cannot authorize this inventory window");
  ledger.recordWindow(world,screen,"entity:42",9);
  if(!ledger.confirmedWindow(request,world,screen,9,1003))throw new AssertionError("a fresh server window for the requested mount must remain controllable");
  if(ledger.confirmedWindow(request,world,new Object(),9,1003)||ledger.confirmedWindow(request,world,screen,8,1003))throw new AssertionError("window identity and handler must both match");
  if(ledger.confirmedWindow(request,other,screen,9,1003)||ledger.confirmedWindow(request,world,screen,9,4001))throw new AssertionError("world changes or late server windows cannot restore ownership");
  if(ledger.confirmedWindow(null,world,screen,9,1003))throw new AssertionError("cancelled or stopped requests cannot own a later menu");
  ledger.changeWorld(other);
  if(ledger.windowAfter(world,screen,0)!=null||ledger.windowAfter(other,screen,0)!=null)throw new AssertionError("server UI evidence does not cross worlds");
  System.out.println("PASS server-open window identity, target, dispatch boundary and world scope");
 }
}
