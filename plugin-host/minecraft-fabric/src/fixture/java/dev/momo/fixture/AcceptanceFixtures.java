package dev.momo.fixture;
import com.google.gson.Gson;
import java.nio.file.*;
import java.util.*;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.block.*;
import net.minecraft.block.entity.ChestBlockEntity;
import net.minecraft.block.enums.BedPart;
import net.minecraft.block.enums.RailShape;
import net.minecraft.entity.EntityType;
import net.minecraft.entity.SpawnReason;
import net.minecraft.entity.passive.VillagerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.Identifier;
import net.minecraft.util.WorldSavePath;
import net.minecraft.util.math.*;
import net.minecraft.village.VillagerProfession;
import net.minecraft.world.GameRules;

/** One-shot developer fixture builder, removed before any acceptance action. */
public final class AcceptanceFixtures implements ModInitializer {
 public void onInitialize(){ServerLifecycleEvents.SERVER_STARTED.register(server->{
  Path save=server.getSavePath(WorldSavePath.ROOT).toAbsolutePath().normalize();
  if(!FixtureGuard.allowed(save,System.getProperty("momo.fixture.prepare","")))return;
  try{prepare(server,save);}catch(Exception error){throw new IllegalStateException("Disposable Minecraft fixture preparation failed",error);}
 });}
 private static void block(ServerWorld world,int x,int y,int z,BlockState state){world.setBlockState(new BlockPos(x,y,z),state,3);}
 private static void block(ServerWorld world,int x,int y,int z,Block type){block(world,x,y,z,type.getDefaultState());}
 private static void chest(ServerWorld world,int x,int z,String... supplies){
  block(world,x,64,z,Blocks.CHEST);
  if(!(world.getBlockEntity(new BlockPos(x,64,z)) instanceof ChestBlockEntity chest))throw new IllegalStateException("Chest unavailable");
  if(supplies.length>27)throw new IllegalArgumentException("Fixture chest overflow");
  for(int i=0;i<supplies.length;i++){
   String[] pair=supplies[i].split("\\*");var id=Identifier.of("minecraft:"+pair[0]);
   if(!Registries.ITEM.containsId(id))throw new IllegalArgumentException("Unknown fixture item "+id);
   var item=Registries.ITEM.get(id);int count=pair.length==1?1:Integer.parseInt(pair[1]);
   var stack=new ItemStack(item,count);if(count<1||count>stack.getMaxCount())throw new IllegalArgumentException("Invalid fixture stack");chest.setStack(i,stack);
  }
  chest.markDirty();
 }
 private static void prepare(MinecraftServer server,Path save)throws Exception{
  ServerWorld world=server.getOverworld();
  world.setSpawnPos(new BlockPos(0,64,0),0);world.setTimeOfDay(13000);world.setWeather(0,24000,false,false);
  world.getGameRules().get(GameRules.DO_DAYLIGHT_CYCLE).set(true,server);
  world.getGameRules().get(GameRules.DO_WEATHER_CYCLE).set(false,server);
  world.getGameRules().get(GameRules.DO_MOB_SPAWNING).set(false,server);
  world.getGameRules().get(GameRules.SPAWN_RADIUS).set(0,server);
  for(int x=-18;x<=18;x++)for(int z=-18;z<=18;z++){
   block(world,x,62,z,Blocks.STONE);block(world,x,63,z,Blocks.GRASS_BLOCK);
   for(int y=64;y<=72;y++)block(world,x,y,z,Blocks.AIR);
  }
  // Material supplies are fixture state, never autonomous acquisition evidence.
  chest(world,-3,-2,"oak_log*64","cobblestone*64","iron_ingot*64","diamond*16","stick*64","oak_planks*64","coal*64","apple*64","iron_sword","shield","bow","arrow*64","crossbow","trident","iron_helmet","iron_chestplate","iron_leggings","iron_boots","lapis_lazuli*64","book*16","experience_bottle*64","glass_bottle*16");
  chest(world,-5,-2,"brewing_stand","blaze_powder*64","nether_wart*64","sugar*64","redstone*64","glowstone_dust*64","fermented_spider_eye*64","magma_cream*64","golden_carrot*64","pufferfish*16","emerald*64","wheat*64","carrot*64","potato*64","beetroot*64","leather*64","white_wool*64","white_banner*16","red_dye*64","netherite_upgrade_smithing_template","netherite_ingot*8","gold_ingot*64","sand*64","raw_iron*64","raw_gold*64","salmon*64");
  chest(world,-7,-5,"oak_boat","minecart","chest_minecart","saddle","flint_and_steel","ender_eye*16","oak_door*16","wheat_seeds*64","bone_meal*64","water_bucket","iron_hoe","diamond_sword","diamond_pickaxe","copper_ingot*64");
  // Review regressions: setup-only materials and visible geometry, never runtime cheats.
  chest(world,-10,-6,"golden_pickaxe","iron_pickaxe","writable_book","oak_sign*16","bucket","stone*64","dirt*64");
  block(world,-15,64,-9,Blocks.DIAMOND_ORE);block(world,-15,64,-6,Blocks.STONE);
  for(int x=-13;x<=-11;x++)for(int y=64;y<=66;y++)block(world,x,y,-14,Blocks.STONE);
  var hiddenDrop=new net.minecraft.entity.ItemEntity(world,-11.5,64.2,-15.5,new ItemStack(net.minecraft.item.Items.DIAMOND));
  hiddenDrop.setNeverDespawn();hiddenDrop.setPickupDelay(32767);world.spawnEntity(hiddenDrop);
  // Full set of ordinary station UIs within a short walk from the spawn.
  Block[] stations={Blocks.CRAFTING_TABLE,Blocks.FURNACE,Blocks.SMOKER,Blocks.BLAST_FURNACE,Blocks.ANVIL,Blocks.GRINDSTONE,Blocks.SMITHING_TABLE,Blocks.LOOM,Blocks.STONECUTTER,Blocks.BREWING_STAND};
  for(int i=0;i<stations.length;i++)block(world,-8+i*2,64,6,stations[i]);
  block(world,0,64,-6,Blocks.ENCHANTING_TABLE);
  for(int x=-2;x<=2;x++)for(int z=-8;z<=-4;z++)if((x==-2||x==2||z==-8)&&!(x==0&&z==-4))block(world,x,64,z,Blocks.BOOKSHELF);
  block(world,4,64,-3,Blocks.BLUE_BED.getDefaultState().with(BedBlock.PART,BedPart.FOOT).with(BedBlock.FACING,Direction.SOUTH));
  block(world,4,64,-2,Blocks.BLUE_BED.getDefaultState().with(BedBlock.PART,BedPart.HEAD).with(BedBlock.FACING,Direction.SOUTH));
  block(world,6,64,-3,Blocks.OAK_DOOR.getDefaultState());block(world,6,65,-3,Blocks.OAK_DOOR.getDefaultState().with(net.minecraft.state.property.Properties.DOUBLE_BLOCK_HALF,net.minecraft.block.enums.DoubleBlockHalf.UPPER));
  for(int x=8;x<=12;x++)for(int z=-1;z<=5;z++)if(x==8||x==12||z==-1||z==5)block(world,x,64,z,Blocks.OAK_FENCE);
  block(world,8,64,2,Blocks.OAK_FENCE_GATE);block(world,10,64,3,Blocks.COMPOSTER);
  var villager=new VillagerEntity(EntityType.VILLAGER,world);villager.setPosition(10.5,64,2.5);
  villager.initialize(world,world.getLocalDifficulty(villager.getBlockPos()),SpawnReason.STRUCTURE,null);
  villager.setVillagerData(villager.getVillagerData().withProfession(VillagerProfession.FARMER).withLevel(1));villager.setPersistent();world.spawnEntity(villager);
  for(int x=-14;x<=-7;x++)for(int z=-3;z<=4;z++){block(world,x,59,z,Blocks.STONE);for(int y=60;y<=63;y++)block(world,x,y,z,Blocks.WATER);}
  for(int x=-5;x<=5;x++)block(world,x,64,-11,Blocks.RAIL.getDefaultState().with(RailBlock.SHAPE,RailShape.EAST_WEST));
  for(int x=-15;x<=-11;x++)for(int y=64;y<=68;y++)if(x==-15||x==-11||y==64||y==68)block(world,x,y,12,Blocks.OBSIDIAN);
  for(int i=-1;i<=1;i++){
   block(world,i,64,10,Blocks.END_PORTAL_FRAME.getDefaultState().with(EndPortalFrameBlock.FACING,Direction.SOUTH));
   block(world,i,64,14,Blocks.END_PORTAL_FRAME.getDefaultState().with(EndPortalFrameBlock.FACING,Direction.NORTH));
   block(world,-2,64,12+i,Blocks.END_PORTAL_FRAME.getDefaultState().with(EndPortalFrameBlock.FACING,Direction.EAST));
   block(world,2,64,12+i,Blocks.END_PORTAL_FRAME.getDefaultState().with(EndPortalFrameBlock.FACING,Direction.WEST));
  }
  block(world,12,63,-8,Blocks.DIRT);block(world,12,64,-8,Blocks.OAK_SAPLING);
  var tree=new BlockPos(12,64,-8);
  for(int stage=0;stage<2&&world.getBlockState(tree).isOf(Blocks.OAK_SAPLING);stage++)((SaplingBlock)Blocks.OAK_SAPLING).generate(world,tree,world.getBlockState(tree),world.getRandom());
  if(!world.getBlockState(tree).isIn(net.minecraft.registry.tag.BlockTags.LOGS))throw new IllegalStateException("Fixture tree did not grow");
  // Separate ordinary mobs for controlled combat. Their real AI / health and
  // damage rules remain enabled; setup is removed before the player acts.
  for(int z:new int[]{18,28,38}){
   for(int x=-34;x<=-30;x++)for(int dz=z-2;dz<=z+2;dz++)if(x==-34||x==-30||dz==z-2||dz==z+2)block(world,x,64,dz,Blocks.OAK_FENCE);
   var cow=new net.minecraft.entity.passive.CowEntity(EntityType.COW,world);cow.setPosition(-32.5,64,z+.5);cow.setPersistent();world.spawnEntity(cow);
  }
  for(int x=32;x<=56;x++)for(int z=-12;z<=12;z++)block(world,x,68,z,Blocks.STONE);
  var skeleton=new net.minecraft.entity.mob.SkeletonEntity(EntityType.SKELETON,world);skeleton.setPosition(44.5,64,.5);
  skeleton.initialize(world,world.getLocalDifficulty(skeleton.getBlockPos()),SpawnReason.STRUCTURE,null);skeleton.setPersistent();world.spawnEntity(skeleton);
  var neutral=new net.minecraft.entity.mob.ZombifiedPiglinEntity(EntityType.ZOMBIFIED_PIGLIN,world);neutral.setPosition(32.5,64,-24.5);neutral.setPersistent();world.spawnEntity(neutral);
  var companion=new net.minecraft.entity.passive.CowEntity(EntityType.COW,world);companion.setPosition(-4.5,64,10.5);companion.setPersistent();world.spawnEntity(companion);
  var horse=new net.minecraft.entity.passive.HorseEntity(EntityType.HORSE,world);horse.setPosition(-4.5,64,12.5);horse.setTame(true);horse.setPersistent();world.spawnEntity(horse);
  Map<String,Object> report=new LinkedHashMap<>(Map.of("version",4,"setupOnly",true,"spawn",List.of(0,64,0),"stationsRow",List.of(-8,64,6),"supplies",List.of(List.of(-3,64,-2),List.of(-5,64,-2),List.of(-7,64,-5)),"villager",List.of(10,64,2),"water",List.of(-10,61,0),"netherFrame",List.of(-13,65,12),"endFrame",List.of(0,64,12)));
  report.put("reviewSupplies",List.of(-10,64,-6));report.put("ore",List.of(-15,64,-9));report.put("hiddenDropWall",List.of(-12,65,-14));report.put("horse",List.of(-4,64,12));
  report.put("followTarget",List.of(-4,64,10));report.put("bed",List.of(4,64,-3));report.put("nightWithDaylightCycle",true);
  report.put("combatTargets",List.of(List.of(-32,64,18),List.of(-32,64,28),List.of(-32,64,38),List.of(44,64,0)));report.put("neutral",List.of(32,64,-25));
  Files.writeString(save.resolve(".momo-fixture-prepared"),new Gson().toJson(report),StandardOpenOption.CREATE_NEW);
  System.getLogger("momo-fixture").log(System.Logger.Level.INFO,"Prepared isolated acceptance world; remove this development mod before acceptance");
 }
}
