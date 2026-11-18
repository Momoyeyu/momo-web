package dev.momo.task;
import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
public final class PlanCoordinatesSmoke {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static class Effect implements TaskRuntime.Work {
  boolean started,stopped;
  public void start(){started=true;}public TaskRuntime.Step tick(){return TaskRuntime.Step.done(Map.of("executed",true));}
  public void pause(){}public void resume(){}public void stop(){stopped=true;}
 }
 static void run(){
  try(var in=PlanCoordinatesSmoke.class.getResourceAsStream("/minecraft-plan-origin.json")){
   check(in!=null,"Shared coordinate fixtures must be packaged in tests");
   var cases=JsonParser.parseReader(new InputStreamReader(in,StandardCharsets.UTF_8)).getAsJsonArray();
   for(var value:cases){var sample=value.getAsJsonObject();var args=sample.getAsJsonObject("args");var original=args.deepCopy();SkillArguments.validate("plan",args);
    check(PlanCoordinates.steps(args).equals(sample.getAsJsonArray("steps")),"World coordinates differ from the independently specified shared fixture: "+sample.get("name"));
    check(args.equals(original),"Do not rewrite original intentions while expanding coordinates");
   }
  }catch(IOException e){throw new AssertionError(e);}
  var args=JsonParser.parseString("{\"origin\":{\"x\":-10,\"y\":64,\"z\":20},\"mode\":\"preview\",\"steps\":[{\"skill\":\"build\",\"args\":{\"box\":{\"x\":0,\"y\":0,\"z\":0,\"width\":3,\"height\":2,\"length\":3,\"block\":\"minecraft:dirt\",\"mode\":\"walls\"}},\"when\":{\"item\":\"minecraft:dirt\",\"count\":16,\"test\":\"atLeast\"}}]}").getAsJsonObject();
  var effects=new ArrayList<Effect>();
  var preview=PlanAssembly.create(args,(skill,a)->{var effect=new Effect();effects.add(effect);return effect;},when->{throw new AssertionError("Preview must not inspect actual inventory");});
  check(effects.isEmpty(),"A preview must not create any physical child executor");
  preview.start();var row=preview.tick();
  check(row.state().equals("succeeded")&&Boolean.TRUE.equals(row.evidence().get("plannedOnly"))&&Boolean.FALSE.equals(row.evidence().get("worldStateChecked")),"Preview completion must explicitly distinguish intent from actual world evidence");
  check(effects.isEmpty(),"Preview start/tick cannot execute effects");preview.stop();
  check(preview.tick().state().equals("failed"),"Stopped preview must not publish a new result");
  args.addProperty("mode","execute");var received=new ArrayList<JsonObject>();
  var execution=PlanAssembly.create(args,(skill,a)->{received.add(a.deepCopy());var effect=new Effect();effects.add(effect);return effect;},when->true);
  check(received.getFirst().getAsJsonObject("box").get("y").getAsInt()==64&&received.getFirst().getAsJsonObject("box").get("x").getAsInt()==-10,"Execution factory must receive world coordinates, not the local input");
  execution.start();check(effects.getFirst().started,"Default task execution must still start the ordinary child");execution.stop();check(effects.getFirst().stopped,"Stop releases the current physical child");
  var misaligned=JsonParser.parseString("{\"steps\":[{\"skill\":\"build\",\"args\":{\"box\":{\"x\":46,\"y\":82,\"z\":-146,\"width\":3,\"height\":2,\"length\":3,\"block\":\"minecraft:dirt\",\"mode\":\"walls\"}}},{\"skill\":\"build\",\"args\":{\"box\":{\"x\":46,\"y\":84,\"z\":-148,\"width\":3,\"height\":1,\"length\":3,\"block\":\"minecraft:dirt\"}}}]}").getAsJsonObject();
  var drawing=new PlanPreview(PlanCoordinates.steps(misaligned));drawing.start();var proof=drawing.tick().evidence();String sketch=(String)proof.get("layoutPreview");
  check(sketch.contains("Y=82, X=46..48, Z=-148..-144\n???\n???\nAAA\nA?A\nAAA\n"),"The real failure's shifted wall footprint must be visible, with unknown cells distinct from air");
  check(sketch.contains("Y=84, X=46..48, Z=-148..-144\nAAA\nAAA\nAAA\n???\n???\n"),"The roof's two-block shift must remain visible rather than silently repaired");
  check(sketch.length()<=1800&&((Number)proof.get("plannedBuildOperations")).intValue()==25,"Bound the model summary and count requested work, never inventory gains");
  for(String invalid:new String[]{"{\"origin\":{\"x\":30000000,\"y\":64,\"z\":0},\"steps\":[{\"skill\":\"mine\",\"args\":{\"x\":1,\"y\":0,\"z\":0}}]}","{\"origin\":{\"x\":0,\"y\":319,\"z\":0},\"steps\":[{\"skill\":\"mine\",\"args\":{\"x\":0,\"y\":1,\"z\":0}}]}"}){
   try{SkillArguments.validate("plan",JsonParser.parseString(invalid).getAsJsonObject());throw new AssertionError("Translated world bounds must remain authoritative");}catch(IllegalArgumentException expected){}
  }
 }
}
