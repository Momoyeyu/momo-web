package dev.momo.task;
public final class SurvivalPolicySmoke {
 static void check(boolean b,String s){if(!b)throw new AssertionError(s);}
 public static void main(String[] args){
  SurvivalPolicy p=new SurvivalPolicy();
  check(p.choose(true,false,false,16,10,true,false,false)==SurvivalPolicy.Mode.EAT,"eat from local hunger");
  check(p.choose(true,false,false,15,12,true,true,true)==SurvivalPolicy.Mode.EAT,"minor threat cannot keep interrupting food");
  check(p.choose(true,false,true,4,12,true,true,true)==SurvivalPolicy.Mode.ESCAPE,"critical danger wins over food");
  check(p.choose(false,false,false,20,20,true,false,true)==SurvivalPolicy.Mode.NONE,"revoked body cannot defend/restart");
  check(p.choose(true,true,false,20,20,true,false,true)==SurvivalPolicy.Mode.NONE,"manual stop wins");
  check(p.choose(true,false,false,20,20,true,false,true)==SurvivalPolicy.Mode.DEFEND,"close hostile defense");
  check(p.interruptOwnedScreen(SurvivalPolicy.Mode.ESCAPE,true),"danger can interrupt our station");
  check(!p.interruptOwnedScreen(SurvivalPolicy.Mode.EAT,true),"hunger alone must not discard station work");
  check(!p.interruptOwnedScreen(SurvivalPolicy.Mode.DEFEND,false),"player menus cannot be dismissed by a reflex");
  System.out.println("PASS survival priority, food continuity and stop barrier");
 }
}
