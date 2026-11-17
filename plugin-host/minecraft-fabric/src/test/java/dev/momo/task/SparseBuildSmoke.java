package dev.momo.task;
import java.util.List;
import com.google.gson.*;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
public final class SparseBuildSmoke {
 public static void main(String[] args){
  try(var in=SparseBuildSmoke.class.getResourceAsStream("/minecraft-build-box.json")){
   for(var entry:JsonParser.parseReader(new InputStreamReader(in,StandardCharsets.UTF_8)).getAsJsonArray()){
    var row=entry.getAsJsonObject();var input=row.getAsJsonObject("args");
    if(row.has("invalid")){try{SkillArguments.validate("build",input);throw new AssertionError("Accepted invalid box "+row.get("name"));}catch(IllegalArgumentException expected){}continue;}
    SkillArguments.validate("build",input);var built=SparseBuild.from(input);
    if(built.cells().size()!=row.get("count").getAsInt())throw new AssertionError("Wrong box expansion count");
    var min=row.getAsJsonArray("min");var max=row.getAsJsonArray("max");
    if(built.x()!=min.get(0).getAsInt()||built.y()!=min.get(1).getAsInt()||built.z()!=min.get(2).getAsInt()||built.x()+built.width()-1!=max.get(0).getAsInt()||built.y()+built.height()-1!=max.get(1).getAsInt()||built.z()+built.length()-1!=max.get(2).getAsInt())throw new AssertionError("Wrong box bounds");
    if(built.cells().stream().anyMatch(c->!c.block().equals(input.getAsJsonObject("box").get("block").getAsString())))throw new AssertionError("Box changed the chosen material");
    if(row.has("excluded"))for(var item:row.getAsJsonArray("excluded")){var p=item.getAsJsonArray();if(built.cells().stream().anyMatch(c->c.x()==p.get(0).getAsInt()&&c.y()==p.get(1).getAsInt()&&c.z()==p.get(2).getAsInt()))throw new AssertionError("Wall intent silently filled its interior");}
   }
  }catch(java.io.IOException error){throw new AssertionError(error);}
  var a=new SparseBuild.Cell(-4,64,2,"minecraft:oak_planks");var b=new SparseBuild.Cell(-2,65,3,"minecraft:oak_slab");var plan=new SparseBuild(List.of(a,b));
  if(plan.width()!=3||plan.height()!=2||plan.length()!=2||!a.equals(plan.local(0,0,0))||plan.local(1,0,0)!=null||!b.equals(plan.local(2,1,1)))throw new AssertionError("sparse world cells need an exact offset, never filling the empty bounding box");
  reject(List.of());reject(List.of(a,a));reject(List.of(a,new SparseBuild.Cell(20,64,2,"minecraft:oak_planks")));
  reject(java.util.Collections.nCopies(33,a));
  var settling=new BuildSettlement(20);
  for(int i=0;i<80;i++)if(settling.missingReceiptExpired(true))throw new AssertionError("Active building has no completion deadline");
  for(int i=0;i<19;i++)if(settling.missingReceiptExpired(false))throw new AssertionError("Library completion must allow server receipts to arrive");
  if(!settling.missingReceiptExpired(false))throw new AssertionError("Missing receipts eventually fail");
  if(settling.missingReceiptExpired(true)||settling.missingReceiptExpired(false))throw new AssertionError("New library activity resets settlement, regardless of total build age");
  var stalled=new BuildProgress(3,6);
  if(stalled.blocked(0,0,64,0)||stalled.blocked(0,0,64,0)||stalled.blocked(0,0,64,0)||!stalled.blocked(0,0,64,0))throw new AssertionError("A stationary blocked builder must yield instead of waiting for its whole task lifetime");
  var circling=new BuildProgress(3,6);
  for(int i=0;i<6;i++)if(circling.blocked(0,i,64,0))throw new AssertionError("Movement permits bounded approach");
  if(!circling.blocked(0,6,64,0))throw new AssertionError("Movement alone cannot count as construction forever");
  if(circling.blocked(1,6,64,0)||circling.blocked(1,6,64,0))throw new AssertionError("Verified construction renews the work budget");
  System.out.println("PASS bounded sparse blueprint, exact offsets and no duplicate/implicit fill");
 }
 private static void reject(List<SparseBuild.Cell> cells){try{new SparseBuild(cells);throw new AssertionError("Accepted invalid build");}catch(IllegalArgumentException expected){}}
}
