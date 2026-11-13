package dev.momo.task;
import com.google.gson.*;
public final class SkillArgumentsSmoke {
 static void validate(String skill,String json){SkillArguments.validate(skill,JsonParser.parseString(json).getAsJsonObject());}
 static void reject(String skill,String json){try{validate(skill,json);throw new AssertionError("Accepted invalid task: "+skill);}catch(IllegalArgumentException expected){}}
 public static void main(String[] args){
  validate("navigate","{\"x\":1,\"y\":64,\"z\":2}");
  validate("plan","{\"steps\":[{\"skill\":\"eat\",\"args\":{},\"retries\":2,\"when\":{\"item\":\"minecraft:apple\",\"count\":1,\"test\":\"atLeast\"}}]}");
  reject("mine","{\"x\":1.5,\"y\":64,\"z\":2}");reject("eat","{\"script\":\"run\"}");
  reject("plan","{\"steps\":[{\"skill\":\"plan\",\"args\":{}}]}");
  reject("attack","{\"entityId\":0}");reject("bash","{}");
  System.out.println("PASS shared skill schema: typed fields, finite plans, no scripts or unknown authority");
 }
}
