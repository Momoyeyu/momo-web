package dev.momo.task;
public final class PickupLedgerSmoke {
 public static void main(String[] args){
  PickupLedger ledger=new PickupLedger();Object world=new Object();long accepted=ledger.cursor();
  ledger.record(world,8,3,1);
  if(ledger.since(world,8,3,accepted)==null)throw new AssertionError("pickup during preceding navigation must survive entity removal");
  if(ledger.since(world,8,4,accepted)!=null)throw new AssertionError("another player is not our pickup");
  if(ledger.since(new Object(),8,3,accepted)!=null)throw new AssertionError("worlds are isolated");
  if(ledger.since(world,8,3,ledger.cursor())!=null)throw new AssertionError("old pickup cannot complete a new request");
  ledger.changeWorld(null);
  if(ledger.since(world,8,3,accepted)!=null)throw new AssertionError("unloaded worlds must not be retained");
  if(ledger.cursor()<=accepted)throw new AssertionError("world changes must not reset receipt sequence");
  System.out.println("PASS pickup event identity, world and submission boundary");
 }
}
