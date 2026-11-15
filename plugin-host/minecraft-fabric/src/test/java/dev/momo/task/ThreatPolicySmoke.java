package dev.momo.task;
public final class ThreatPolicySmoke {
 private static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 public static void main(String[] args){
  check(ThreatPolicy.recent(false,999,true),"Client damage packets identify a real attacker even when the server-side tracked attacker field is empty");
  check(!ThreatPolicy.recent(true,121,false)&&!ThreatPolicy.recent(true,-1,false),"Expired or future tracked attackers do not stay hostile");
  check(ThreatPolicy.recent(true,120,false)&&!ThreatPolicy.recent(false,0,false),"A valid tracked attacker remains compatible without inventing aggression");
  check(ThreatPolicy.danger(true,true,false,false,false,true,400),"a visible skeleton twenty blocks away is a real ranged threat");
  check(!ThreatPolicy.danger(false,true,false,true,false,true,4),"hidden entities must not be discovered by local defense");
  check(!ThreatPolicy.danger(true,true,true,false,false,false,4),"a calm enderman or piglin must not be attacked just for being a monster");
  check(ThreatPolicy.danger(true,true,true,true,false,false,16),"a visibly aggressive neutral can be defended against");
  check(!ThreatPolicy.danger(true,false,false,false,false,false,4),"nearby players and passive animals are not default enemies");
  check(ThreatPolicy.danger(true,false,false,false,true,false,400),"actual recent aggression can identify an attacker without a separate PvP mode");
  check(!ThreatPolicy.danger(true,true,false,false,false,false,100),"ordinary distant melee mobs should not constantly interrupt the goal");
  check(!ThreatPolicy.danger(true,true,false,false,false,true,1100),"defense remains within bounded visible knowledge");
  System.out.println("PASS visible ranged threats, neutral/passive protection and bounded retaliation");
 }
}
