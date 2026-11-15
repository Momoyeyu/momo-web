package dev.momo.task;
public final class SurvivalPolicySmoke {
 static void check(boolean b,String s){if(!b)throw new AssertionError(s);}
 public static void main(String[] args){
  FoodChoiceSmoke.main(args);
  CombatWithdrawalSmoke.main(args);
  ThreatPolicySmoke.main(args);
  BlastAvoidanceSmoke.main(args);
  ProjectileAimSmoke.main(args);
  SurvivalPolicy p=new SurvivalPolicy();
  check(p.airCritical(99,false),"air escape starts before the last breath");
  check(p.airCritical(180,true),"do not immediately dive again with a partially recovered breath");
  check(!p.airCritical(250,true),"air escape finishes after sufficient recovery");
  check(p.escapePitch(true,80)<0,"escape from water must look upward even after chasing a target below");
  check(p.escapePitch(false,20)==20,"ordinary land retreat retains its aim");
  check(p.canDrive(false,true,true,true),"our food preparation screen must not suspend the same survival owner");
  check(!p.canDrive(false,true,true,false),"a player menu is never an owned food screen");
  check(!p.canDrive(true,true,false,true),"pause prevents every survival action");
  check(!p.canDrive(false,false,false,true),"focus loss prevents every survival action");
  check(p.choose(true,false,false,16,10,true,false,false)==SurvivalPolicy.Mode.EAT,"eat from local hunger");
  check(p.choose(true,false,false,15,12,true,true,true)==SurvivalPolicy.Mode.EAT,"minor threat cannot keep interrupting food");
  check(p.choose(true,false,true,4,12,true,true,true)==SurvivalPolicy.Mode.ESCAPE,"critical danger wins over food");
  check(p.choose(true,false,false,6,12,true,false,true)==SurvivalPolicy.Mode.ESCAPE,"low health must retreat before entering a suicidal last two hearts");
  check(p.choose(false,false,false,20,20,true,false,true)==SurvivalPolicy.Mode.NONE,"revoked body cannot defend/restart");
  check(p.choose(true,true,false,20,20,true,false,true)==SurvivalPolicy.Mode.NONE,"manual stop wins");
  check(p.choose(true,false,false,20,20,true,false,true)==SurvivalPolicy.Mode.DEFEND,"close hostile defense");
  check(p.interruptOwnedScreen(SurvivalPolicy.Mode.ESCAPE,true),"danger can interrupt our station");
  check(!p.interruptOwnedScreen(SurvivalPolicy.Mode.EAT,true),"hunger alone must not discard station work");
  check(!p.interruptOwnedScreen(SurvivalPolicy.Mode.DEFEND,false),"player menus cannot be dismissed by a reflex");
  check(p.forBody(SurvivalPolicy.Mode.ESCAPE,true,false)==SurvivalPolicy.Mode.ESCAPE,"lava/air danger interrupts even an eating skill");
  check(p.forBody(SurvivalPolicy.Mode.EAT,true,false)==SurvivalPolicy.Mode.NONE,"a skill already eating keeps its own lifecycle");
  check(p.forBody(SurvivalPolicy.Mode.DEFEND,false,true)==SurvivalPolicy.Mode.NONE,"a compatible combat task keeps pursuing instead of being stalled");
  System.out.println("PASS survival priority, food continuity and stop barrier");
 }
}
