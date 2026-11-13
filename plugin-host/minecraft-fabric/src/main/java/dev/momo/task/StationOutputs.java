package dev.momo.task;
import java.util.Set;
/** Vanilla output positions only. Backpack/input slots never satisfy processing. */
public final class StationOutputs {
 public static Set<Integer> indices(String screen){return switch(screen){
  case "minecraft:furnace","minecraft:smoker","minecraft:blast_furnace","minecraft:anvil","minecraft:grindstone","minecraft:merchant"->Set.of(2);
  case "minecraft:brewing_stand"->Set.of(0,1,2);
  case "minecraft:crafting","minecraft:inventory","minecraft:enchantment"->Set.of(0);
  case "minecraft:stonecutter"->Set.of(1);
  case "minecraft:smithing","minecraft:loom"->Set.of(3);
  default->Set.of();
 };}
 public static boolean hasButtons(String screen){return Set.of("minecraft:enchantment","minecraft:loom","minecraft:stonecutter").contains(screen);}
}
