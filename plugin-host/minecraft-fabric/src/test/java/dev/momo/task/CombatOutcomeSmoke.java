package dev.momo.task;
public final class CombatOutcomeSmoke {
 public static void main(String[] args){
  CombatWithdrawalSmoke.main(args);
  if(CombatOutcome.of(true,false,20)!=CombatOutcome.LOST)throw new AssertionError("unloaded/teleported target is not a confirmed kill");
  if(CombatOutcome.of(false,false,0)!=CombatOutcome.DEAD)throw new AssertionError("observed zero health confirms death");
  if(CombatOutcome.of(true,true,20)!=CombatOutcome.DEAD)throw new AssertionError("explicit vanilla killed removal is a death receipt");
  if(CombatOutcome.of(false,false,4)!=CombatOutcome.ACTIVE)throw new AssertionError("low target health is not completion");
  var blocks=new ShieldBlocks();var world=new Object();blocks.changeWorld(world);
  blocks.record(world,2,1);if(blocks.count(world)!=0)throw new AssertionError("Another player's shield is not our defense proof");
  blocks.record(world,1,1);blocks.record(world,1,1);if(blocks.count(world)!=2)throw new AssertionError("Only actual local-player server block events count");
  blocks.changeWorld(new Object());if(blocks.count(world)!=0)throw new AssertionError("Shield evidence cannot cross a world instance");
  System.out.println("PASS combat death evidence versus target disappearance");
 }
}
