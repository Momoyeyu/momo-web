package dev.momo.task;
public final class BlockReceiptsSmoke {
 public static void main(String[] args){
  BlockReceipts receipts=new BlockReceipts();Object world=new Object();long accepted=receipts.cursor();
  if(receipts.after(world,1,64,2,accepted)!=null)throw new AssertionError("client prediction is not a server receipt");
  receipts.record(world,1,64,2,"minecraft:air","air");
  if(receipts.after(world,1,64,2,accepted)==null)throw new AssertionError("matching server block fact must be available");
  if(receipts.after(world,2,64,2,accepted)!=null)throw new AssertionError("another block cannot prove this action");
  if(receipts.after(world,1,64,2,receipts.cursor())!=null)throw new AssertionError("old packet cannot confirm a new task");
  receipts.changeWorld(null);
  if(receipts.after(world,1,64,2,accepted)!=null)throw new AssertionError("old world must be released");
  var time=new java.util.concurrent.atomic.AtomicLong(1000);
  var own=new BlockReceipts(time::get);var a=new Object();var b=new Object();
  own.record(a,1,64,2,"minecraft:air","air");
  if(!own.facts(a,"player").isEmpty())throw new AssertionError("Unclaimed server updates must not expose hidden terrain");
  own.claimMine(a,"player","minecraft:overworld",1,64,2,own.cursor(),"minecraft:oak_log");
  if(!own.facts(a,"player").isEmpty())throw new AssertionError("An old packet cannot become an owned mining fact");
  time.set(2000);own.claimMine(a,"player","minecraft:overworld",1,64,2,0,"minecraft:oak_log");
  if(own.facts(a,"player").size()!=1||own.facts(a,"player").getFirst().observedAt()!=1000)throw new AssertionError("Use the server observation time, not later delivery time");
  if(!own.facts(a,"other-player").isEmpty())throw new AssertionError("An account change cannot inherit another character’s facts");
  long revision=own.facts(a,"player").getFirst().seq();
  own.claimMine(a,"player","minecraft:overworld",1,64,2,0,"minecraft:oak_log");
  if(own.facts(a,"player").getFirst().seq()!=revision)throw new AssertionError("Duplicate receipts must stay idempotent");
  own.observeAbsence(a,"player","minecraft:overworld",2,64,2);
  if(!own.facts(a,"player").getLast().source().equals("visible_absence")||own.facts(a,"player").getLast().serverBlockSeq()!=0)throw new AssertionError("Sight is never presented as a server mutation");
  own.observeAbsence(a,"other-player","minecraft:overworld",2,64,2);
  if(own.facts(a,"other-player").size()!=1)throw new AssertionError("A new account’s same-tick observation is not an old account’s duplicate");
  for(int i=0;i<200;i++)own.observeAbsence(a,"player","minecraft:overworld",i,64,3);
  if(own.facts(a,"player").size()!=128)throw new AssertionError("Fact snapshots must be bounded");
  if(!own.facts(b,"player").isEmpty())throw new AssertionError("Another world must not read old facts");
  own.changeWorld(b);if(!own.facts(a,"player").isEmpty()||!own.facts(b,"player").isEmpty())throw new AssertionError("World changes clear the projection");
  System.out.println("PASS server block receipt position, world and action boundary");
 }
}
