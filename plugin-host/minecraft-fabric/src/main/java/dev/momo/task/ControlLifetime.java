package dev.momo.task;
/** An input pulse is not an activity grant. Heartbeats cannot revive a revoked body. */
public final class ControlLifetime {
 private boolean armed,primitive;private long leaseUntil,primitiveUntil;
 private static void duration(long value){if(value<1||value>10000)throw new IllegalArgumentException("Invalid control duration");}
 public void arm(long now,long lease){duration(lease);armed=true;leaseUntil=now+lease;}
 public void renew(long now,long lease){duration(lease);if(armed&&now<leaseUntil)leaseUntil=now+lease;}
 public boolean armed(){return armed;}
 public boolean primitive(){return primitive;}
 public boolean controlling(boolean task){return task||armed||primitive;}
 public boolean idleGuard(){return armed&&!primitive;}
 public boolean leaseExpired(long now){return armed&&now>=leaseUntil;}
 public void beginPrimitive(long now,long duration){
  duration(duration);if(!armed||leaseExpired(now))throw new IllegalStateException("Control activity expired");
  primitive=true;primitiveUntil=now+duration;
 }
 public boolean primitiveExpired(long now){return primitive&&now>=primitiveUntil;}
 public void endPrimitive(){primitive=false;primitiveUntil=0;}
 public void revoke(){armed=false;leaseUntil=0;endPrimitive();}
}
