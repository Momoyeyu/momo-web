package dev.momo.task;
public final class RetreatMemorySmoke {
 static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}
 public static void main(String[] args){
  var memory=new RetreatMemory();memory.health(5);
  check(!memory.defer(7,144,false),"a first withdrawal still runs");
  memory.reachedSafety(7);
  for(int i=0;i<100;i++){memory.health(5);check(memory.defer(7,144,false),"a safely separated same threat must not start a new idle retreat every tick");}
  memory.reachedSafety(8);check(memory.defer(7,144,false)&&memory.defer(8,169,false),"multiple already escaped threats cannot oscillate");
  check(!memory.defer(7,80,false),"the threat approaching again must rearm protection");
  check(!memory.defer(99,144,false),"a new threat is not suppressed");
  var oldDamage=new Object();memory.damage(oldDamage);memory.reachedSafety(8);memory.damage(oldDamage);check(memory.defer(8,169,false),"old damage packets do not create repeated emergencies");
  memory.damage(new Object());check(!memory.defer(8,169,false),"a fresh received hit rearms protection even with absorption");
  memory.reachedSafety(8);
  memory.health(4);check(!memory.defer(8,169,false),"actual health loss invalidates old safety");
  var policy=new SurvivalPolicy();check(policy.choose(true,false,true,5,17,false,false,!memory.defer(8,169,false))==SurvivalPolicy.Mode.ESCAPE,"critical blast/air/fire always overrides the separation memory");
  memory.reachedSafety(8);memory.health(7);check(!memory.defer(8,169,false),"healing out of emergency state clears old safety");
  memory.health(5);memory.reachedSafety(8);memory.clear();check(!memory.defer(8,169,false),"stop or new activity cannot inherit reflex memory");
  var ranged=new RetreatMemory();ranged.health(5);ranged.reachedSafety(10);
  check(!ranged.defer(10,400,true),"a ranged threat reentering twenty blocks must not remain suppressed");
  ranged.reachedSafety(10);check(ranged.defer(10,784,true),"safely separated ranged enemy is deferred");
  check(ranged.defer(10,625,true),"ranged reapproach has a stable margin outside attack range");
  check(!ranged.defer(10,624,true),"ranged reapproach rearms before the attack boundary");
  System.out.println("PASS bounded retreat safety memory, reapproach, damage, recovery and stop");
 }
}
