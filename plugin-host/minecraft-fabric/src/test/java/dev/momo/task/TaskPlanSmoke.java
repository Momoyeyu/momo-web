package dev.momo.task;
import java.util.*;
public final class TaskPlanSmoke {
 static void check(boolean b,String s){if(!b)throw new AssertionError(s);}
 static class Work implements TaskRuntime.Work {
  int starts,stops;boolean fail;
  public void start(){starts++;}
  public TaskRuntime.Step tick(){return fail?TaskRuntime.Step.failed("blocked"):TaskRuntime.Step.done(Map.of("count",1));}
  public void stop(){stops++;}public void pause(){}public void resume(){}
  public boolean retrySafe(String reason){return true;}
 }
 public static void main(String[] args){
  Work meal=new Work(){public boolean handlesEating(){return true;}public TaskRuntime.Step tick(){return TaskRuntime.Step.running();}};
  Work restore=new Work();
  TaskPlan eating=new TaskPlan(List.of(new TaskPlan.Node(meal,()->true,0,false),new TaskPlan.Node(restore,()->true,0,false)));
  TaskRuntime revokedMeal=new TaskRuntime();revokedMeal.submit("food","plan",eating,0,1000);
  revokedMeal.tick(1);check(revokedMeal.handlesEating(),"nested eating retains the same body ownership");
  revokedMeal.stop("user_takeover");revokedMeal.tick(2);
  check(restore.starts==0,"equipment restoration may not click slots after control is revoked");
  Work a=new Work(),b=new Work();
  TaskPlan p=new TaskPlan(List.of(new TaskPlan.Node(a,()->true,0,false),new TaskPlan.Node(b,()->true,0,false)));
  p.start();check(p.tick().state().equals("running")&&b.starts==1,"chain locally without inference");
  check(p.tick().state().equals("succeeded"),"complete after both observed outcomes");
  p.stop();check(a.stops==1&&b.stops==1,"each owner released once");
  Work f=new Work();f.fail=true;
  TaskPlan retry=new TaskPlan(List.of(new TaskPlan.Node(f,()->true,1,false)));
  retry.start();retry.tick();check(f.starts==2,"bounded retry");
  check(retry.tick().state().equals("failed"),"retry exhausted is failure");retry.stop();check(f.stops==2,"stop failed step once");
  Work uncertain=new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.failed("server_confirmation_missing");}};
  TaskPlan unknown=new TaskPlan(List.of(new TaskPlan.Node(uncertain,()->true,2,true),new TaskPlan.Node(new Work(),()->true,0,false)));
  unknown.start();check(unknown.tick().state().equals("failed")&&uncertain.starts==1,"unknown outcome cannot be retried or skipped into another mutation");
  Work unsafe=new Work(){public boolean retrySafe(String reason){return false;}};unsafe.fail=true;
  TaskPlan noReplay=new TaskPlan(List.of(new TaskPlan.Node(unsafe,()->true,2,false)));
  noReplay.start();noReplay.tick();check(unsafe.starts==1,"failure does not authorize replaying a side effect");
  Work skipped=new Work();TaskPlan conditional=new TaskPlan(List.of(new TaskPlan.Node(skipped,()->false,0,false)));
  conditional.start();check(conditional.tick().state().equals("succeeded")&&skipped.starts==0,"condition checked from actual state");
  TaskRuntime runtime=new TaskRuntime();Work first=new Work(),second=new Work();second.fail=true;
  TaskPlan partial=new TaskPlan(List.of(new TaskPlan.Node(first,()->true,0,false),new TaskPlan.Node(second,()->true,0,false)));
  runtime.submit("partial","plan",partial,0,10000);runtime.tick(1);runtime.tick(2);
  check(runtime.snapshot("partial").state().equals("failed"),"later failure remains a failure");
  check(((List<?>)runtime.snapshot("partial").evidence().get("steps")).size()==1,"failed plan retains already observed effects");
  TaskRuntime stopped=new TaskRuntime();TaskPlan cancel=new TaskPlan(List.of(new TaskPlan.Node(new Work(),()->true,0,false),new TaskPlan.Node(new Work(),()->true,0,false)));
  stopped.submit("cancel","plan",cancel,0,10000);stopped.tick(1);stopped.stop("requested");
  check(((List<?>)stopped.snapshot("cancel").evidence().get("steps")).size()==1,"cancelling future work does not erase actual completed work");
  Work gathering=new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.running();}public Map<String,Object> partialEvidence(){return Map.of("countAfter",5);}};
  TaskPlan currentPartial=new TaskPlan(List.of(new TaskPlan.Node(gathering,()->true,0,false)));
  TaskRuntime interrupted=new TaskRuntime();interrupted.submit("gathering","plan",currentPartial,0,1000);interrupted.tick(1);interrupted.stop("requested");
  check(((List<?>)interrupted.snapshot("gathering").evidence().getOrDefault("steps",List.of())).size()==1,"cancel retains current child actual gains");
  for(String timeout:List.of("ingredients_station_or_server_ack_missing","trade_stock_or_currency_missing")){
   Work unconfirmed=new Work(){public TaskRuntime.Step tick(){return TaskRuntime.Step.failed(timeout);}};Work next=new Work();
   TaskPlan noSkip=new TaskPlan(List.of(new TaskPlan.Node(unconfirmed,()->true,0,true),new TaskPlan.Node(next,()->true,0,false)));
   noSkip.start();check(noSkip.tick().state().equals("failed")&&next.starts==0,"missing final server ACK cannot advance a plan");
  }
  Work rejected=new Work(){public TaskRuntime.Step tick(){throw new TaskRuntime.Rejected("target_not_visible");}};
  TaskPlan rejectedRetry=new TaskPlan(List.of(new TaskPlan.Node(rejected,()->true,1,false)));
  rejectedRetry.start();check(rejectedRetry.tick().state().equals("running")&&rejected.starts==2,"a typed rejection during tick follows the same bounded retry policy as a returned failure");
  check(rejectedRetry.tick().reason().equals("step_0:target_not_visible")&&rejected.stops==2,"retry exhaustion preserves the typed reason and releases once per attempt");
  Work absent=new Work(){public TaskRuntime.Step tick(){throw new TaskRuntime.Rejected("target_not_visible");}};Work fallback=new Work();
  TaskPlan alternative=new TaskPlan(List.of(new TaskPlan.Node(absent,()->true,0,true),new TaskPlan.Node(fallback,()->true,0,false)));
  alternative.start();check(alternative.tick().state().equals("running")&&fallback.starts==1&&absent.stops==1,"a declared skip handles a known typed tick rejection locally");
  check(alternative.tick().state().equals("succeeded"),"the fallback still needs its own real result");
  for(boolean typed:List.of(false,true)){
   Work uncertainThrow=new Work(){public TaskRuntime.Step tick(){if(typed)throw new TaskRuntime.Rejected("server_confirmation_missing");throw new IllegalStateException("response disappeared");}public Map<String,Object> partialEvidence(){return Map.of("countAfter",5);}};Work later=new Work();
   TaskPlan uncertainPlan=new TaskPlan(List.of(new TaskPlan.Node(uncertainThrow,()->true,2,true),new TaskPlan.Node(later,()->true,0,false)));
   TaskRuntime uncertainRuntime=new TaskRuntime();uncertainRuntime.submit("uncertain","plan",uncertainPlan,0,1000);uncertainRuntime.tick(1);
   var result=uncertainRuntime.snapshot("uncertain");
   check(result.state().equals("failed")&&result.reason().equals("step_0:"+(typed?"server_confirmation_missing":"execution_failed")),"uncertain tick failure stays unknown and retains its reason");
   check(uncertainThrow.starts==1&&uncertainThrow.stops==1&&later.starts==0,"uncertain side effects cannot be retried or skipped even if the child advertises retry safety");
   check(((List<?>)result.evidence().get("steps")).size()==1,"typed and unexpected exceptions retain actual partial state");
  }
  Work brokenStart=new Work(){public void start(){super.start();throw new IllegalStateException("unknown start outcome");}public Map<String,Object> partialEvidence(){return Map.of("countAfter",5);}};Work afterStart=new Work();
  TaskPlan startUnknown=new TaskPlan(List.of(new TaskPlan.Node(brokenStart,()->true,2,true),new TaskPlan.Node(afterStart,()->true,0,false)));
  startUnknown.start();
  check(startUnknown.tick().reason().equals("step_0:start_failed")&&brokenStart.starts==1&&afterStart.starts==0,"an unexpected exception during dispatch has the same no-replay/no-skip rule as tick");
  System.out.println("PASS bounded local plans, result verification, conditions and retry ownership");
 }
}
