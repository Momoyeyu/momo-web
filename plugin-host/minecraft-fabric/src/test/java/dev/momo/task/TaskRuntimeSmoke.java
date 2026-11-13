package dev.momo.task;

import java.util.Map;

public final class TaskRuntimeSmoke {
 static class Work implements TaskRuntime.Work {
  int starts,stops,pauses,resumes;boolean done,failed;
  public void start(){starts++;}
  public TaskRuntime.Step tick(){return failed?TaskRuntime.Step.failed("blocked"):done?TaskRuntime.Step.done(Map.of("actualCount",4)):TaskRuntime.Step.running();}
  public void pause(){pauses++;}
  public void resume(){resumes++;}
  public void stop(){stops++;}
 }
 static void check(boolean ok,String why){if(!ok)throw new AssertionError(why);}
 public static void main(String[] args){
  TaskRuntime invalid=new TaskRuntime();
  Work missing=new Work(){public void start(){throw new TaskRuntime.Rejected("target_not_visible");}};
  invalid.submit("missing","mine",missing,0,10000);invalid.tick(1);
  check(invalid.snapshot("missing").reason().equals("target_not_visible"),"expected game conditions return a useful reason, not a transport failure");
  TaskRuntime runtime=new TaskRuntime();Work a=new Work(),b=new Work();
  runtime.submit("a","mine",a,0,10000);runtime.submit("b","craft",b,0,10000);
  check(runtime.snapshot("a").state().equals("queued"),"accepted is not success");
  runtime.tick(1);check(a.starts==1&&b.starts==0,"single physical owner");
  check(!runtime.submit("a","mine",a,2,10000),"duplicate must not replay");
  a.done=true;runtime.tick(3);runtime.tick(4);check(b.starts==1,"next skill follows without model round trip");
  check(runtime.snapshot("a").evidence().get("actualCount").equals(4),"completion carries actual result");
  runtime.pause();runtime.tick(5);check(b.pauses==1&&runtime.snapshot("b").state().equals("paused"),"pause body");
  runtime.resume();runtime.tick(6);check(b.resumes==1,"resume same task");
  runtime.stop("user_takeover");runtime.tick(7);
  check(b.stops==1&&runtime.snapshot("b").state().equals("cancelled"),"stop terminalizes running body");
  check(!runtime.events(0).events().isEmpty(),"ordered events available");
  Work c=new Work();runtime.submit("c","navigate",c,100,1000);runtime.tick(1100);
  check(c.starts==0&&runtime.snapshot("c").reason().equals("lease_expired"),"expired queued task never starts");
  Work d=new Work();runtime.submit("d","navigate",d,2000,1000);runtime.tick(2001);
  runtime.heartbeat(2100,1000);runtime.tick(3050);
  check(runtime.snapshot("d").state().equals("running"),"heartbeat independent of model");
  runtime.tick(3100);check(runtime.snapshot("d").state().equals("failed"),"lease expiry releases body");
  for(int i=0;i<140;i++){Work w=new Work();w.done=true;runtime.submit("j"+i,"craft",w,4000+i,1000);runtime.tick(4000+i);}
  check(runtime.events(0).gap(),"event cursor gap requires snapshot recovery");
  TaskRuntime broken=new TaskRuntime();
  Work stubborn=new Work(){public void stop(){throw new IllegalStateException("device not stopped");}};
  broken.submit("uncertain","navigate",stubborn,0,1000);broken.tick(1);broken.stop("revoke");
  check(!broken.stopConfirmed(),"failed native stop must be visible");
  boolean refused=false;try{broken.submit("unsafe","craft",new Work(),2,1000);}catch(IllegalStateException expected){refused=true;}
  check(refused,"uncertain physical ownership blocks new tasks");
  TaskRuntime ids=new TaskRuntime();
  ids.submit("same","navigate","1,2,3",new Work(),0,1000);
  boolean conflict=false;try{ids.submit("same","navigate","4,5,6",new Work(),1,1000);}catch(IllegalArgumentException expected){conflict=true;}
  check(conflict,"same id with different arguments must be rejected");
  runtime.resetSession();check(runtime.snapshots().isEmpty(),"new authority scope has no old tasks");
  boolean blockedReset=false;try{broken.resetSession();}catch(IllegalStateException expected){blockedReset=true;}
  check(blockedReset,"new scope cannot hide an unconfirmed stop");
  TaskRuntime recovering=new TaskRuntime();
  Work intermittent=new Work(){public void stop(){stops++;if(stops==1)throw new IllegalStateException("temporarily unavailable");}};
  recovering.submit("retry","navigate",intermittent,0,1000);recovering.tick(1);recovering.stop("world_left");
  check(!recovering.stopConfirmed(),"first stop uncertain");
  recovering.stop("world_left");
  check(recovering.stopConfirmed(),"stop must retry even after world tick becomes unavailable");
  TaskRuntime report=new TaskRuntime();
  Work evolving=new Work(){public Map<String,Object> progress(){return Map.of("skill","craft","ticks",starts);}};
  report.submit("progress","plan",evolving,0,5000);report.tick(1000);
  check(report.snapshot("progress").progress().get("skill").equals("craft"),"progress is separate from verified completion evidence");
  check(report.snapshot("progress").evidence().isEmpty(),"running progress is not a completed result");
  TaskRuntime idle=new TaskRuntime();idle.notice("manual_takeover");
  check(idle.events(0).events().get(0).task().reason().equals("manual_takeover"),"manual idle-body takeover must reach the coordinator");
  check(idle.stopConfirmed(),"a control notice cannot create new work");
  System.out.println("PASS task queue, evidence, duplicate barrier, pause/resume, stop, heartbeat and event gap");
 }
}
