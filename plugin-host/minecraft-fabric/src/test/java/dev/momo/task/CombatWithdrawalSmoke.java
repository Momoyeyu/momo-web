package dev.momo.task;
public final class CombatWithdrawalSmoke {
 public static void main(String[] args){
  var prey=new CombatWithdrawal();
  if(!prey.update(2,9,0,false,false).isEmpty())throw new AssertionError("Low health alone must not prevent hunting a harmless prey animal");
  if(!prey.update(2,9,1,false,true).equals("retreating"))throw new AssertionError("A target that actually becomes dangerous must still trigger retreat immediately");
  if(!prey.update(8,25,20,false,false).equals("retreating"))throw new AssertionError("Once danger started a retreat, momentary calm cannot turn the body back");
  var retreat=new CombatWithdrawal();
  if(!retreat.update(20,9,1,false).isEmpty())throw new AssertionError("Healthy combat does not retreat without danger");
  if(!retreat.update(5.3f,9,2,false).equals("retreating"))throw new AssertionError("Low health begins withdrawal immediately");
  if(!retreat.update(7,25,20,false).equals("retreating"))throw new AssertionError("Regenerating one heart must not turn back into the fight");
  if(!retreat.update(10,145,50,false).equals("retreated_low_health"))throw new AssertionError("Actual separation ends withdrawal for a new goal decision");
  var trapped=new CombatWithdrawal();trapped.update(5,4,1,false);
  if(!trapped.update(7,4,80,false).equals("retreating")||!trapped.update(7,4,81,false).equals("unreachable"))throw new AssertionError("A blocked escape must fail clearly, not press backward forever");
  var ranged=new CombatWithdrawal();
  if(!ThreatPolicy.danger(true,true,false,false,false,true,400))throw new AssertionError("A visible ranged enemy at twenty blocks is still dangerous");
  if(!ranged.update(5,400,1,true).equals("retreating"))throw new AssertionError("Do not end a ranged retreat inside the body's own threat radius");
  if(!ranged.update(7,700,20,false).equals("retreating"))throw new AssertionError("Remember the ranged threat even when healing or its held weapon changes");
  if(!ranged.update(7,784,40,true).equals("retreated_low_health"))throw new AssertionError("Real ranged separation ends the retreat");
  var blockedRanged=new CombatWithdrawal();blockedRanged.update(5,400,1,true);
  if(!blockedRanged.update(5,400,81,true).equals("unreachable"))throw new AssertionError("Ranged escape remains bounded when obstructed");
  System.out.println("PASS combat withdrawal survives regeneration and bounds blocked escape");
 }
}
