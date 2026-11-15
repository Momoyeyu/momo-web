package dev.momo.task;
public final class InteractionOutcomeSmoke {
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 static InteractionOutcome.State state(int vehicle,String block,long blockSeq,int count,int damage,boolean confirmed,Object screen,int handler,long inventorySeq){
  return new InteractionOutcome.State(screen,handler,screen!=null,inventorySeq,block,blockSeq,vehicle,false,new InteractionOutcome.Hand("minecraft:wheat",count,damage,36),confirmed);
 }
 static InteractionOutcome.State baseline(int vehicle){return state(vehicle,"closed",10,3,0,false,null,0,20);}
 public static void main(String[] args){
  var mount=new InteractionOutcome(baseline(99),100,20,10,42);
  check(mount.effect(baseline(99),104).isEmpty(),"already riding another entity must not prove a new interaction");
  check(new InteractionOutcome(baseline(42),100,20,10,42).effect(baseline(42),104).isEmpty(),"already riding the target also is not a fresh click result");
  check(mount.effect(baseline(42),100).isEmpty()&&mount.effect(baseline(42),103).isEmpty(),"long approach time must not count as post-dispatch settling");
  check(mount.effect(baseline(42),104).equals("mounted_target"),"new riding identity must match the requested entity");
  var block=new InteractionOutcome(baseline(99),100,20,10,-1);
  check(block.effect(state(99,"open",10,3,0,false,null,0,20),104).isEmpty(),"predicted or old target state without a fresh server block receipt is not success");
  check(block.effect(state(99,"open",11,3,0,false,null,0,20),104).equals("block_changed"),"a fresh server change at the dispatched block can prove the effect");
  check(mount.effect(state(99,"closed",10,4,0,true,null,0,21),104).isEmpty(),"passive pickup into the held stack must not be credited to the click");
  check(mount.effect(state(99,"closed",10,2,0,false,null,0,20),104).isEmpty(),"local predicted consumption needs server confirmation");
  check(mount.effect(state(99,"closed",10,2,0,true,null,0,21),104).equals("held_item_changed"),"confirmed consumption of the actual interaction hand is correlated");
  check(mount.effect(state(99,"closed",10,3,1,true,null,0,21),104).equals("held_item_changed"),"server-confirmed tool wear is a real interaction result");
  var bucketBefore=new InteractionOutcome.State(null,0,false,20,"",0,-1,false,new InteractionOutcome.Hand("minecraft:bucket",1,0,36),false);
  var milkAfter=new InteractionOutcome.State(null,0,false,21,"",0,-1,false,new InteractionOutcome.Hand("minecraft:milk_bucket",1,0,36),true);
  check(new InteractionOutcome(bucketBefore,100,20,10,42).effect(milkAfter,104).equals("held_item_changed"),"confirmed hand transformation covers milking without counting unrelated inventory gains");
  var sleeping=new InteractionOutcome.State(new Object(),0,false,20,"bed",10,-1,true,baseline(-1).hand(),false);
  check(block.effect(sleeping,104).equals("sleeping")&&block.ownsWindow(sleeping.window(),0,false,true,true),"sleeping must newly match the dispatched bed, with its own sleep screen");
  var alreadySleeping=new InteractionOutcome(sleeping,100,20,10,-1);
  check(alreadySleeping.effect(sleeping,104).isEmpty(),"an old sleep state does not prove another bed interaction");
  var window=new Object();
  check(block.ownsWindow(window,2,true,false,false),"a new server window can stay owned while its initial snapshot arrives");
  check(block.effect(state(99,"closed",10,3,0,false,window,2,20),104).isEmpty(),"window appearance alone is not a server inventory snapshot");
  check(block.effect(state(99,"closed",10,3,0,false,window,2,21),104).equals("screen_opened"),"a new handler with a fresh server snapshot proves opening");
  check(!block.ownsWindow(window,0,true,false,false),"an unchanged handler cannot pretend to be a new server container");
  check(!block.ownsWindow(window,2,false,false,false),"a player-created menu is not owned merely because it has a new object or handler");
  var clientMenu=new InteractionOutcome.State(window,2,false,999,"closed",10,99,false,baseline(99).hand(),false);
  check(block.effect(clientMenu,104).isEmpty(),"unrelated inventory snapshots cannot turn an unconfirmed client menu into click success");
  var book=new Object();block.confirmWindow(book);
  check(block.ownsWindow(book,0,false,false,false),"a window opened synchronously by the interaction is causally owned, including non-container UI");
  check(block.effect(state(99,"closed",10,3,0,false,book,0,20),104).equals("screen_opened"),"local UI opening is observable UI evidence, not a fabricated world change");
  block.invalidate();
  check(block.interrupted()&&block.effect(state(99,"open",11,2,0,true,window,2,21),104).isEmpty(),"another body owner's later inventory/window changes cannot complete the old click");
  System.out.println("PASS dispatch-local interaction baselines, target identity, server receipts and pause boundary");
 }
}
