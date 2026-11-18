package dev.momo.task;
import com.google.gson.*;
import java.util.Set;
/** The plan's immutable origin is data, never a new world observation or authority. */
public final class PlanCoordinates {
 private PlanCoordinates(){}
 public static JsonArray steps(JsonObject args){
  var result=args.getAsJsonArray("steps").deepCopy();
  if(!args.has("origin"))return result;var origin=args.getAsJsonObject("origin");
  for(var value:result){var step=value.getAsJsonObject();var a=step.getAsJsonObject("args");String skill=step.get("skill").getAsString();
   if(Set.of("navigate","mine","place","interactBlock").contains(skill))point(a,origin);
   if(skill.equals("build")){
    if(a.has("cells")&&a.get("cells").isJsonArray())for(var cell:a.getAsJsonArray("cells"))if(cell.isJsonObject())point(cell.getAsJsonObject(),origin);
    if(a.has("box")&&a.get("box").isJsonObject())point(a.getAsJsonObject("box"),origin);
   }
  }
  return result;
 }
 private static void point(JsonObject point,JsonObject origin){
  for(String axis:new String[]{"x","y","z"})if(point.has(axis)){
   var value=point.get(axis);
   if(!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isNumber())throw new IllegalArgumentException("Invalid plan coordinate");
   double n=value.getAsDouble();
   if(!Double.isFinite(n)||n!=Math.rint(n)||n<Integer.MIN_VALUE||n>Integer.MAX_VALUE)throw new IllegalArgumentException("Invalid plan coordinate");
   long world=(long)n+origin.get(axis).getAsLong();
   if(world<Integer.MIN_VALUE||world>Integer.MAX_VALUE)throw new IllegalArgumentException("Invalid plan coordinate");
   point.addProperty(axis,world);
  }
 }
}
