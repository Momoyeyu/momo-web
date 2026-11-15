package dev.momo.task;
public final class CombatWithdrawalSmoke {
 public static void main(String[] args){
  var retreat=new CombatWithdrawal();
  if(!retreat.update(20,9,1).isEmpty())throw new AssertionError("Healthy combat does not retreat without danger");
  if(!retreat.update(5.3f,9,2).equals("retreating"))throw new AssertionError("Low health begins withdrawal immediately");
  if(!retreat.update(7,25,20).equals("retreating"))throw new AssertionError("Regenerating one heart must not turn back into the fight");
  if(!retreat.update(10,145,50).equals("retreated_low_health"))throw new AssertionError("Actual separation ends withdrawal for a new goal decision");
  var trapped=new CombatWithdrawal();trapped.update(5,4,1);
  if(!trapped.update(7,4,80).equals("retreating")||!trapped.update(7,4,81).equals("unreachable"))throw new AssertionError("A blocked escape must fail clearly, not press backward forever");
  System.out.println("PASS combat withdrawal survives regeneration and bounds blocked escape");
 }
}
