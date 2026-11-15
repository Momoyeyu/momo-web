package dev.momo.task;
public final class ControlLifetimeSmoke {
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 public static void main(String[] args){
  var body=new ControlLifetime();body.arm(1000,10000);
  // An instantaneous look/hotbar command has no held primitive afterwards.
  body.endPrimitive();check(body.controlling(false),"instant operations must leave the activity's takeover/reflex guard armed");
  body.beginPrimitive(1100,500);
  check(body.primitive()&&!body.primitiveExpired(1599)&&body.primitiveExpired(1600),"a held input ends at its own deadline");
  check(!body.idleGuard(),"idle reflex processing must not starve a running primitive");
  body.endPrimitive();check(body.idleGuard()&&!body.leaseExpired(1600),"finishing a primitive preserves the body lease and enables idle safety");
  body.renew(2000,10000);check(!body.leaseExpired(11999)&&body.leaseExpired(12000),"only body heartbeats renew the activity guard");
  body.revoke();body.renew(3000,10000);
  check(!body.controlling(false)&&!body.primitive(),"stop/handoff cannot be undone by a delayed heartbeat");
  check(body.controlling(true),"the semantic executor still owns its separately admitted task");
  try{body.beginPrimitive(3000,500);throw new AssertionError("revoked body accepted input");}catch(IllegalStateException expected){}
  body.arm(4000,10000);check(body.idleGuard(),"a new explicit activity can arm the body again");
  System.out.println("PASS distinct activity and primitive lifetimes");
 }
}
