package dev.momo.task;
import com.google.gson.*;
public final class SkillArgumentsSmoke {
 static void validate(String skill,String json){SkillArguments.validate(skill,JsonParser.parseString(json).getAsJsonObject());}
 static void reject(String skill,String json){try{validate(skill,json);throw new AssertionError("Accepted invalid task: "+skill);}catch(IllegalArgumentException expected){}}
 public static void main(String[] args){
  if(SkillArguments.legacyFollowTicks(1)!=1||SkillArguments.legacyFollowTicks(51)!=2||SkillArguments.legacyFollowTicks(500)!=10||SkillArguments.legacyFollowTicks(1000)!=20)throw new AssertionError("Legacy bounded follow milliseconds must not become a one-minute task");
  for(int duration:new int[]{0,-1,1001})try{SkillArguments.legacyFollowTicks(duration);throw new AssertionError("Invalid legacy follow duration");}catch(IllegalArgumentException expected){}
  if(!GatherSight.belowFeet(0,63,0,.2,.2,.8,.8,64)||!GatherSight.belowFeet(0,62,0,.2,.2,.8,.8,64))throw new AssertionError("Gather must not dig down through the player's support column");
  if(GatherSight.belowFeet(1,63,0,.2,.2,.8,.8,64)||GatherSight.belowFeet(0,64,0,.2,.2,.8,.8,64))throw new AssertionError("Nearby floor and wall sources remain available");
  if(!GatherSight.belowFeet(-1,63,0,-.1,.2,.5,.8,64))throw new AssertionError("Protect the full footprint across block boundaries");
  if(!GatherSight.belowFeet(0,63,0,.2,.2,.8,.8,63.5))throw new AssertionError("A half slab's support is inside the feet block, not below its floored Y");
  validate("navigate","{\"x\":1,\"y\":64,\"z\":2}");
  validate("navigate","{\"x\":1,\"y\":64,\"z\":2,\"terrain\":\"adapt\"}");
  validate("navigate","{\"x\":1,\"y\":64,\"z\":2,\"terrain\":\"preserve\"}");
  reject("navigate","{\"x\":1,\"y\":64,\"z\":2,\"terrain\":\"teleport\"}");
  if(!SkillArguments.resourceId("oak_log").equals("minecraft:oak_log"))throw new AssertionError("vanilla identifiers need their default namespace");
  if(!SkillArguments.resourceId("example:oak_log").equals("example:oak_log"))throw new AssertionError("mod namespaces must be preserved");
  validate("navigate","{\"x\":1,\"y\":64,\"z\":2,\"height\":\"surface\"}");
  validate("navigate","{\"x\":1,\"z\":2,\"height\":\"surface\"}");
  validate("plan","{\"steps\":[{\"skill\":\"navigate\",\"args\":{\"x\":1,\"z\":2,\"height\":\"surface\"}}]}");
  reject("navigate","{\"x\":1,\"z\":2}");
  reject("navigate","{\"x\":1,\"z\":2,\"height\":\"exact\"}");
  reject("navigate","{\"x\":1,\"y\":\"64\",\"z\":2,\"height\":\"surface\"}");
  reject("navigate","{\"x\":1,\"y\":64,\"z\":2,\"height\":\"teleport\"}");
  validate("rename","{\"name\":\"momo の剣\"}");
  validate("selectItem","{\"item\":\"minecraft:crafting_table\"}");
  validate("placeNearby","{\"item\":\"minecraft:crafting_table\"}");
  reject("selectItem","{\"item\":\"minecraft:stone\",\"hotbar\":9}");
  ItemSelectionSmoke.main(args);
  MiningToolChoiceSmoke.main(args);
  validate("build","{\"cells\":[{\"x\":1,\"y\":64,\"z\":2,\"block\":\"minecraft:oak_planks\"}]}");
  reject("build","{\"cells\":[]}");
  SparseBuildSmoke.main(args);
  validate("rename","{\"name\":\"\"}");
  reject("rename","{\"name\":\"line\\nbreak\"}");
  validate("gather","{\"item\":\"minecraft:oak_log\",\"count\":4}");
  validate("plan","{\"steps\":[{\"skill\":\"eat\",\"args\":{},\"retries\":2,\"when\":{\"item\":\"minecraft:apple\",\"count\":1,\"test\":\"atLeast\"}}]}");
  reject("mine","{\"x\":1.5,\"y\":64,\"z\":2}");reject("eat","{\"script\":\"run\"}");
  reject("plan","{\"steps\":[{\"skill\":\"plan\",\"args\":{}}]}");
  reject("attack","{\"entityId\":0}");reject("bash","{}");
  System.out.println("PASS shared skill schema: typed fields, finite plans, no scripts or unknown authority");
 }
}
