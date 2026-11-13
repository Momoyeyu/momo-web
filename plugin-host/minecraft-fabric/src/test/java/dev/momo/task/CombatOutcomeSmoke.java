package dev.momo.task;
public final class CombatOutcomeSmoke {
 public static void main(String[] args){
  if(CombatOutcome.of(true,false,20)!=CombatOutcome.LOST)throw new AssertionError("unloaded/teleported target is not a confirmed kill");
  if(CombatOutcome.of(false,false,0)!=CombatOutcome.DEAD)throw new AssertionError("observed zero health confirms death");
  if(CombatOutcome.of(true,true,20)!=CombatOutcome.DEAD)throw new AssertionError("explicit vanilla killed removal is a death receipt");
  if(CombatOutcome.of(false,false,4)!=CombatOutcome.ACTIVE)throw new AssertionError("low target health is not completion");
  System.out.println("PASS combat death evidence versus target disappearance");
 }
}
