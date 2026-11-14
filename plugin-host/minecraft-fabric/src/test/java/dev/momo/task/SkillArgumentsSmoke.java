package dev.momo.task;
import com.google.gson.*;
public final class SkillArgumentsSmoke {
 static void validate(String skill,String json){SkillArguments.validate(skill,JsonParser.parseString(json).getAsJsonObject());}
 static void reject(String skill,String json){try{validate(skill,json);throw new AssertionError("Accepted invalid task: "+skill);}catch(IllegalArgumentException expected){}}
 public static void main(String[] args){
  if(!GatherSight.belowFeet(0,63,0,.2,.2,.8,.8,64)||!GatherSight.belowFeet(0,62,0,.2,.2,.8,.8,64))throw new AssertionError("Gather must not dig down through the player's support column");
  if(GatherSight.belowFeet(1,63,0,.2,.2,.8,.8,64)||GatherSight.belowFeet(0,64,0,.2,.2,.8,.8,64))throw new AssertionError("Nearby floor and wall sources remain available");
  if(!GatherSight.belowFeet(-1,63,0,-.1,.2,.5,.8,64))throw new AssertionError("Protect the full footprint across block boundaries");
  if(!GatherSight.belowFeet(0,63,0,.2,.2,.8,.8,63.5))throw new AssertionError("A half slab's support is inside the feet block, not below its floored Y");
  validate("navigate","{\"x\":1,\"y\":64,\"z\":2}");
  if(!SkillArguments.resourceId("oak_log").equals("minecraft:oak_log"))throw new AssertionError("vanilla identifiers need their default namespace");
  if(!SkillArguments.resourceId("example:oak_log").equals("example:oak_log"))throw new AssertionError("mod namespaces must be preserved");
  validate("navigate","{\"x\":1,\"y\":64,\"z\":2,\"height\":\"surface\"}");
  reject("navigate","{\"x\":1,\"y\":64,\"z\":2,\"height\":\"teleport\"}");
  validate("gather","{\"item\":\"minecraft:oak_log\",\"count\":4}");
  validate("plan","{\"steps\":[{\"skill\":\"eat\",\"args\":{},\"retries\":2,\"when\":{\"item\":\"minecraft:apple\",\"count\":1,\"test\":\"atLeast\"}}]}");
  reject("mine","{\"x\":1.5,\"y\":64,\"z\":2}");reject("eat","{\"script\":\"run\"}");
  reject("plan","{\"steps\":[{\"skill\":\"plan\",\"args\":{}}]}");
  reject("attack","{\"entityId\":0}");reject("bash","{}");
  System.out.println("PASS shared skill schema: typed fields, finite plans, no scripts or unknown authority");
 }
}
