package dev.momo.task;
import java.util.*;
/** Timers are not evidence of healing or an unseen sunrise. */
public final class ConditionWaitSmoke {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static class Scene implements ConditionWait.Scene {
  Map<String,Object> value;int reads;
  Scene(Map<String,Object> value){this.value=value;}
  public Map<String,Object> observe(){reads++;return value;}
 }
 public static void main(String[] args){
  for(long time:new long[]{0,6000,18000,Long.MAX_VALUE}){
   check(DaylightState.observe(true,false,false,time).equals(Map.of("phase","unknown","source","none","reason","sky_occluded")),"A closed roof without a clock cannot reveal hidden time");
   check(DaylightState.observe(false,true,true,time).get("phase").equals("unknown"),"A clock in a dimension without a natural sky is not a daylight observation");
  }
  for(var row:Map.of(0L,"day",11999L,"day",12000L,"sunset",12999L,"sunset",13000L,"night",22999L,"night",23000L,"dawn",23999L,"dawn").entrySet()){
   check(DaylightState.observe(true,true,false,row.getKey()).equals(Map.of("phase",row.getValue(),"source","sky")),"Actual sky phase boundary "+row.getKey());
   check(DaylightState.observe(true,false,true,row.getKey()).equals(Map.of("phase",row.getValue(),"source","clock")),"An owned clock can be consulted under a roof");
  }
  check(DaylightState.observe(true,true,false,24000).get("phase").equals("day"),"Daylight wraps independently of elapsed world age");
  var hidden=new Scene(Map.of("daylight",DaylightState.observe(true,false,false,6000)));
  var wait=new ConditionWait("daylight",null,12000,hidden);var jobs=new TaskRuntime();jobs.submit("blind","waitUntil",wait,0,10000);jobs.tick(0);
  var blind=jobs.snapshot("blind");check(blind.state().equals("failed")&&blind.reason().equals("condition_unobservable"),"Unobservable daylight must fail, not spend ten minutes or report a successful timer");
  check(((Map<?,?>)blind.evidence().get("observed")).get("phase").equals("unknown"),"Keep the actual blockage as evidence");
  var scene=new Scene(Map.of("daylight",Map.of("phase","night","source","sky")));
  wait=new ConditionWait("daylight",null,100,scene);wait.start();check(wait.tick().state().equals("running"),"A still visible night has not reached daylight");
  scene.value=Map.of("daylight",Map.of("phase","day","source","sky"));TaskRuntime.Step step=null;
  for(int i=0;i<20;i++){step=wait.tick();if(!step.state().equals("running"))break;}
  check(step.state().equals("succeeded")&&((Map<?,?>)step.evidence().get("observed")).get("phase").equals("day")&&scene.reads==2,"Use a fresh actual phase with bounded one-second sampling, no model polling");
  scene=new Scene(Map.of("health",3.0));wait=new ConditionWait("health",18,20,scene);jobs=new TaskRuntime();jobs.submit("heal","waitUntil",wait,0,10000);
  for(int i=0;i<20;i++)jobs.tick(i*50);
  var timed=jobs.snapshot("heal");check(timed.state().equals("failed")&&timed.reason().equals("condition_timeout")&&((Map<?,?>)timed.evidence().get("observed")).get("health").equals(3.0),"Elapsed time without healing is a timeout, not recovery");
  scene=new Scene(Map.of("food",10));wait=new ConditionWait("food",18,80,scene);wait.start();wait.tick();wait.pause();scene.value=Map.of("food",20);
  for(int i=0;i<10;i++)check(wait.tick().state().equals("running"),"A paused wait cannot advance or finish");
  check(scene.reads==1,"No paused observation");wait.resume();check(wait.tick().state().equals("succeeded")&&scene.reads==2,"Resume rechecks current evidence immediately");
  scene=new Scene(Map.of("health",20.0));wait=new ConditionWait("health",18,100,scene);wait.start();wait.stop();check(wait.tick().state().equals("failed")&&scene.reads==0,"A stopped condition cannot read or complete later");
  scene=new Scene(Map.of("daylight",Map.of("phase","night","source","sky")));wait=new ConditionWait("daylight",null,100,scene);wait.start();wait.tick();scene.value=Map.of();
  for(int i=0;i<20;i++)step=wait.tick();
  check(step.state().equals("failed")&&wait.partialEvidence().get("observed").equals(Map.of()),"A missing current reading must not relabel the previous night sample as current evidence");
 }
}
