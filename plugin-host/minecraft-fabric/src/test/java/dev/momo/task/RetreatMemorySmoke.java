package dev.momo.task;
public final class RetreatMemorySmoke {
 static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}
 public static void main(String[] args){
  var memory=new RetreatMemory();memory.health(5);
  check(!memory.defer(7,144),"a first withdrawal still runs");
  memory.reachedSafety(7);
  for(int i=0;i<100;i++){memory.health(5);check(memory.defer(7,144),"a safely separated same threat must not start a new idle retreat every tick");}
  memory.reachedSafety(8);check(memory.defer(7,144)&&memory.defer(8,169),"multiple already escaped threats cannot oscillate");
  check(!memory.defer(7,80),"the threat approaching again must rearm protection");
  check(!memory.defer(99,144),"a new threat is not suppressed");
  var oldDamage=new Object();memory.damage(oldDamage);memory.reachedSafety(8);memory.damage(oldDamage);check(memory.defer(8,169),"old damage packets do not create repeated emergencies");
  memory.damage(new Object());check(!memory.defer(8,169),"a fresh received hit rearms protection even with absorption");
  memory.reachedSafety(8);
  memory.health(4);check(!memory.defer(8,169),"actual health loss invalidates old safety");
  var policy=new SurvivalPolicy();check(policy.choose(true,false,true,5,17,false,false,!memory.defer(8,169))==SurvivalPolicy.Mode.ESCAPE,"critical blast/air/fire always overrides the separation memory");
  memory.reachedSafety(8);memory.health(7);check(!memory.defer(8,169),"healing out of emergency state clears old safety");
  memory.health(5);memory.reachedSafety(8);memory.clear();check(!memory.defer(8,169),"stop or new activity cannot inherit reflex memory");
  System.out.println("PASS bounded retreat safety memory, reapproach, damage, recovery and stop");
 }
}
