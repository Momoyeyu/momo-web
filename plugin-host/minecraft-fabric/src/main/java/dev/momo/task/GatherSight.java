package dev.momo.task;
/** Sampling normal sight, never enumerating hidden terrain or querying loot tables. */
public final class GatherSight {
 private GatherSight(){}
 public static boolean belowFeet(int x,int y,int z,double minX,double minZ,double maxX,double maxZ,double feetY){return y<feetY&&x+1>minX&&x<maxX&&z+1>minZ&&z<maxZ;}
 // Keep the same equal-area sphere, but interleave latitudes in each bounded
 // tick batch. Zenith-first ordering chased distant uphill soil before nearby floor.
 public static double[] direction(int index){int sample=Integer.reverse(index)>>>23;double y=1-2*(sample+.5)/512,angle=sample*2.399963229728653,r=Math.sqrt(Math.max(0,1-y*y));return new double[]{Math.sin(angle)*r,y,Math.cos(angle)*r};}
 public static boolean normalDrop(String block,String item){
  return switch(block){
   case "minecraft:stone" -> item.equals("minecraft:cobblestone");
   case "minecraft:grass_block","minecraft:dirt_path","minecraft:farmland" -> item.equals("minecraft:dirt");
   case "minecraft:coal_ore","minecraft:deepslate_coal_ore" -> item.equals("minecraft:coal");
   case "minecraft:iron_ore","minecraft:deepslate_iron_ore" -> item.equals("minecraft:raw_iron");
   case "minecraft:copper_ore","minecraft:deepslate_copper_ore" -> item.equals("minecraft:raw_copper");
   case "minecraft:gold_ore","minecraft:deepslate_gold_ore" -> item.equals("minecraft:raw_gold");
   case "minecraft:diamond_ore","minecraft:deepslate_diamond_ore" -> item.equals("minecraft:diamond");
   case "minecraft:redstone_ore","minecraft:deepslate_redstone_ore" -> item.equals("minecraft:redstone");
   case "minecraft:lapis_ore","minecraft:deepslate_lapis_ore" -> item.equals("minecraft:lapis_lazuli");
   case "minecraft:nether_quartz_ore" -> item.equals("minecraft:quartz");
   default -> false;
  };
 }
}
