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
  ledger.changeWorld(other);
  if(ledger.windowAfter(world,screen,0)!=null||ledger.windowAfter(other,screen,0)!=null)throw new AssertionError("server UI evidence does not cross worlds");
  System.out.println("PASS server-open window identity, target, dispatch boundary and world scope");
 }
}
