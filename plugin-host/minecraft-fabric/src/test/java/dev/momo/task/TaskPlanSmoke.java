package dev.momo.task;
import java.util.*;
public final class TaskPlanSmoke {
 static void check(boolean b,String s){if(!b)throw new AssertionError(s);}
 static class Work implements TaskRuntime.Work {
  int starts,stops;boolean fail;
  public void start(){starts++;}
  public TaskRuntime.Step tick(){return fail?TaskRuntime.Step.failed("blocked"):TaskRuntime.Step.done(Map.of("count",1));}
  public void stop(){stops++;}public void pause(){}public void resume(){}
 }
 public static void main(String[] args){
  Work a=new Work(),b=new Work();
  TaskPlan p=new TaskPlan(List.of(new TaskPlan.Node(a,()->true,0,false),new TaskPlan.Node(b,()->true,0,false)));
  p.start();check(p.tick().state().equals("running")&&b.starts==1,"chain locally without inference");
  check(p.tick().state().equals("succeeded"),"complete after both observed outcomes");
  p.stop();check(a.stops==1&&b.stops==1,"each owner released once");
  Work f=new Work();f.fail=true;
  TaskPlan retry=new TaskPlan(List.of(new TaskPlan.Node(f,()->true,1,false)));
  retry.start();retry.tick();check(f.starts==2,"bounded retry");
  check(retry.tick().state().equals("failed"),"retry exhausted is failure");retry.stop();check(f.stops==2,"stop failed step once");
  Work skipped=new Work();TaskPlan conditional=new TaskPlan(List.of(new TaskPlan.Node(skipped,()->false,0,false)));
  conditional.start();check(conditional.tick().state().equals("succeeded")&&skipped.starts==0,"condition checked from actual state");
  System.out.println("PASS bounded local plans, result verification, conditions and retry ownership");
 }
}
