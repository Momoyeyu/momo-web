package dev.momo.task;
import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;

/** Same packaged data contract used by Cordis. Deliberately a small non-executable schema subset. */
public final class SkillArguments {
 private static final JsonObject CONTRACT=load();
 private static JsonObject load(){try(var in=SkillArguments.class.getResourceAsStream("/momo-skills.json")){if(in==null)throw new IOException("Missing skill contract");return JsonParser.parseReader(new InputStreamReader(in,StandardCharsets.UTF_8)).getAsJsonObject();}catch(IOException error){throw new IllegalStateException(error);}}
 public static JsonObject contract(){return CONTRACT.deepCopy();}
 public static String resourceId(String value){return net.minecraft.util.Identifier.of(value).toString();}
 public static void validate(String name,JsonObject args){
  if(!CONTRACT.has(name))throw new IllegalArgumentException("Unsupported skill");
  if(args.toString().getBytes(StandardCharsets.UTF_8).length>3500)throw new IllegalArgumentException("Invalid skill size");
  validateValue(CONTRACT.getAsJsonObject(name).getAsJsonObject("parameters"),args);
  if(name.equals("plan"))for(var row:args.getAsJsonArray("steps")){var step=row.getAsJsonObject();validate(step.get("skill").getAsString(),step.getAsJsonObject("args"));}
 }
 private static void validateValue(JsonObject schema,JsonElement value){
  if(value==null||value.isJsonNull())throw new IllegalArgumentException("Invalid skill value");
  switch(schema.get("type").getAsString()){
   case "object" -> {
    if(!value.isJsonObject())throw new IllegalArgumentException("Invalid skill object");var object=value.getAsJsonObject();var props=schema.getAsJsonObject("properties");
    if(schema.has("required"))for(var key:schema.getAsJsonArray("required"))if(!object.has(key.getAsString()))throw new IllegalArgumentException("Missing skill field");
    for(String key:object.keySet()){
     if(props!=null&&props.has(key))validateValue(props.getAsJsonObject(key),object.get(key));
     else if(schema.has("additionalProperties")&&!schema.get("additionalProperties").getAsBoolean())throw new IllegalArgumentException("Invalid skill field");
    }
   }
   case "array" -> {if(!value.isJsonArray())throw new IllegalArgumentException("Invalid skill array");var array=value.getAsJsonArray();if(array.size()<schema.get("minItems").getAsInt()||array.size()>schema.get("maxItems").getAsInt())throw new IllegalArgumentException("Invalid skill length");for(var item:array)validateValue(schema.getAsJsonObject("items"),item);}
   case "integer" -> {if(!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isNumber())throw new IllegalArgumentException("Invalid number");double d=value.getAsDouble();if(!Double.isFinite(d)||d!=Math.rint(d)||d<schema.get("minimum").getAsDouble()||d>schema.get("maximum").getAsDouble())throw new IllegalArgumentException("Invalid number");}
   case "string" -> {
    if(!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isString())throw new IllegalArgumentException("Invalid string");String text=value.getAsString();
    if(text.length()<schema.get("minLength").getAsInt()||text.length()>schema.get("maxLength").getAsInt()||text.chars().anyMatch(c->c<32))throw new IllegalArgumentException("Invalid string");
    if(schema.has("enum")&&!schema.getAsJsonArray("enum").contains(value))throw new IllegalArgumentException("Invalid choice");
   }
   default -> throw new IllegalArgumentException("Unsupported schema");
  }
 }
}
