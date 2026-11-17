package dev.momo.task;
import java.util.*;
/** A bounded local predicate, not a successful timer masquerading as a result. */
final class ConditionWait implements TaskRuntime.Work {
 interface Scene {Map<String,Object> observe();}
 private final String condition;private final Integer minimum;private final int limit;private final Scene scene;
 private Map<String,Object> observed=Map.of();private int ticks,nextSample;private boolean closed=true,paused;
 ConditionWait(String condition,Integer minimum,int limit,Scene scene){this.condition=condition;this.minimum=minimum;this.limit=limit;this.scene=scene;}
 public void start(){ticks=0;nextSample=1;closed=paused=false;observed=Map.of();}
 public TaskRuntime.Step tick(){
  if(closed)return TaskRuntime.Step.failed("activity_ended");if(paused)return TaskRuntime.Step.running();
  ++ticks;
  if(ticks>=nextSample||ticks>=limit){
   var value=scene.observe();observed=Map.of();nextSample=ticks+20;boolean matched;
   if(condition.equals("daylight")||condition.equals("night")){
    if(!(value.get("daylight") instanceof Map<?,?> daylight))return TaskRuntime.Step.failed("condition_unobservable");
    var copy=new LinkedHashMap<String,Object>();daylight.forEach((k,v)->{if(k instanceof String key)copy.put(key,v);});observed=Map.copyOf(copy);
    if(!Set.of("day","sunset","night","dawn").contains(observed.get("phase")))return TaskRuntime.Step.failed("condition_unobservable");
    matched=observed.get("phase").equals(condition.equals("daylight")?"day":"night");
   }else{
    Object actual=value.get(condition);observed=actual==null?Map.of():Map.of(condition,actual);
    if(!(actual instanceof Number number)||!Double.isFinite(number.doubleValue())||number.doubleValue()<0||number.doubleValue()>20)return TaskRuntime.Step.failed("condition_unobservable");
    matched=number.doubleValue()>=minimum;
   }
   if(matched)return TaskRuntime.Step.done(partialEvidence());
  }
  return ticks>=limit?TaskRuntime.Step.failed("condition_timeout"):TaskRuntime.Step.running();
 }
 public void pause(){paused=true;}
 public void resume(){if(!closed){paused=false;nextSample=ticks+1;}}
 public void stop(){closed=true;}
 public Map<String,Object> progress(){return Map.of("skill","waitUntil","condition",condition,"ticks",ticks,"limit",limit,"observed",observed);}
 public Map<String,Object> partialEvidence(){var evidence=new LinkedHashMap<String,Object>();evidence.put("condition",condition);if(minimum!=null)evidence.put("minimum",minimum);evidence.put("elapsedGameTicks",ticks);evidence.put("observed",observed);return Map.copyOf(evidence);}
}
