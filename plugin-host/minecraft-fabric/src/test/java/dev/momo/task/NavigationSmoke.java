package dev.momo.task;

/** Verifies lifecycle without substituting a fake for the real Fabric/Baritone smoke. */
public final class NavigationSmoke {
 static final class Driver implements NavigationTask.Driver {
  boolean arrived, failed; int starts, stops;
  public void start(int x,int y,int z){starts++;}
  public void stop(){stops++;}
  public boolean arrived(){return arrived;}
  public boolean failed(){return failed;}
 }
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args){
  Driver d=new Driver(); NavigationTask t=new NavigationTask(d);
  t.start("first",1,2,3,100,1000);
  check(t.state().equals("running"),"acceptance is not completion");
  t.tick(110);check(t.state().equals("running"),"continue locally without model");
  d.arrived=true;t.tick(120);check(t.state().equals("succeeded"),"verify actual arrival");
  check(d.stops==1,"release on completion");
  check(!t.start("first",1,2,3,130,1000),"duplicate task must not replay");
  d.arrived=false;t.start("second",1,2,3,200,1000);t.cancel("manual_takeover");
  d.arrived=true;t.tick(210);check(t.state().equals("cancelled"),"late arrival cannot resurrect task");
  t.start("third",1,2,3,300,1000);d.arrived=false;t.tick(1300);
  check(t.state().equals("failed")&&t.reason().equals("lease_expired"),"lost heartbeat releases control");
  t.start("fourth",1,2,3,1500,1000);d.failed=true;t.tick(1510);
  check(t.state().equals("failed")&&t.reason().equals("unreachable"),"do not spin on failed path");
  System.out.println("PASS navigation lifecycle: continuous, evidenced arrival, idempotency, cancel, lease, unreachable");
 }
}
