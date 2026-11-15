package dev.momo.task;
import java.util.*;
/** Harvest suitability wins before speed; the whole owned main inventory is eligible. */
public final class MiningToolChoice {
 public record Tool(int slot,boolean suitable,float speed){public Tool{if(slot<0||slot>35||!Float.isFinite(speed)||speed<0)throw new IllegalArgumentException("Invalid mining tool");}}
 private MiningToolChoice(){}
 public static OptionalInt choose(List<Tool> tools,boolean required,int selected){
  Tool best=null;
  for(var tool:tools){
   if(required&&!tool.suitable()||!required&&tool.speed()<=1)continue;
   if(best==null||tool.speed()>best.speed()||tool.speed()==best.speed()&&tool.slot()==selected)best=tool;
  }
  return best==null?OptionalInt.empty():OptionalInt.of(best.slot());
 }
}
