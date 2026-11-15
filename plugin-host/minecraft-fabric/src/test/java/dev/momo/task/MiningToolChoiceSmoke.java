package dev.momo.task;
import java.util.List;
public final class MiningToolChoiceSmoke {
 private static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 public static void main(String[] args){
  PreparedMineSkillSmoke.main(args);
  var hand=new MiningToolChoice.Tool(0,false,1);var pack=new MiningToolChoice.Tool(12,true,2);
  check(MiningToolChoice.choose(List.of(hand,pack),true,0).orElseThrow()==12,"a suitable pickaxe in the main backpack must be usable, not reported missing");
  check(MiningToolChoice.choose(List.of(new MiningToolChoice.Tool(4,false,10),pack),true,4).orElseThrow()==12,"mining speed cannot substitute for the harvest requirement");
  check(MiningToolChoice.choose(List.of(hand,new MiningToolChoice.Tool(20,false,6)),false,0).orElseThrow()==20,"an owned faster axe in the backpack should prepare automatically for wood");
  check(MiningToolChoice.choose(List.of(hand),true,0).isEmpty(),"missing required tools cannot be invented");
  check(MiningToolChoice.choose(List.of(hand),false,0).isEmpty(),"ordinary hand mining needs no pointless inventory work");
  check(MiningToolChoice.choose(List.of(new MiningToolChoice.Tool(2,true,6),new MiningToolChoice.Tool(4,true,6)),true,4).orElseThrow()==4,"equivalent tools should keep the current selection stable");
  System.out.println("PASS all-inventory mining tool suitability, speed and stable selection");
 }
}
