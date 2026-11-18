package dev.momo.task;
import com.google.gson.*;
import java.util.*;
import java.util.function.*;
/** Validated plans share one coordinate expansion and the existing local executor. */
final class PlanAssembly {
 private PlanAssembly(){}
 static TaskRuntime.Work create(JsonObject args,BiFunction<String,JsonObject,TaskRuntime.Work> factory,Predicate<JsonObject> inventory){
  var steps=PlanCoordinates.steps(args);
  if(args.has("mode")&&args.get("mode").getAsString().equals("preview"))return new PlanPreview(steps);
  var work=new ArrayList<TaskPlan.Node>();
  for(var value:steps){
   var step=value.getAsJsonObject();var condition=step.has("when")?step.getAsJsonObject("when"):null;
   work.add(new TaskPlan.Node(factory.apply(step.get("skill").getAsString(),step.getAsJsonObject("args")),()->condition==null||inventory.test(condition),step.has("retries")?step.get("retries").getAsInt():0,step.has("onFailure")&&step.get("onFailure").getAsString().equals("skip")));
  }
  return new TaskPlan(work);
 }
}
