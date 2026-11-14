package dev.momo.task;
import java.util.*;
public final class StationOptionsSmoke {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args){
  var names=List.of("minecraft:stone_stairs","minecraft:stone_bricks","minecraft:stone_slab","minecraft:smooth_stone_slab");
  check(StationOptions.matching(names,"SLAB",1).equals(List.of(2)),"filtered station results must preserve the real button id, not renumber from zero");
  check(StationOptions.matching(names,"",2).equals(List.of(0,1)),"default options must stay bounded");
  check(StationOptions.matching(names,"missing",8).isEmpty(),"unknown recipes cannot create fabricated options");
  check(!RenameProof.matches("momo","momo","named",Map.of()),"a predicted preview alone is not a rename receipt");
  check(!RenameProof.matches("momo","momo","named",Map.of(0,"named")),"an unrelated input update cannot confirm the output");
  check(!RenameProof.matches("momo","other","named",Map.of(2,"named")),"server output must have the requested name");
  check(RenameProof.matches("momo","momo","named",Map.of(2,"named")),"actual matching output confirms rename preview");
  check(RenameProof.matches("","","plain",Map.of(2,"plain")),"clearing a name needs the same server confirmation");
  System.out.println("PASS station option identity/bounds and actual renamed output proof");
 }
}
