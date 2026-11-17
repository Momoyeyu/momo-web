package dev.momo.task;
import com.google.gson.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.registry.Registries;
import net.minecraft.item.ItemStack;

/** Bounded normal-player facts; no hidden entities, underground scans or server privileges. */
public final class GameObservation {
 public static java.util.Map<String,Object> daylight(MinecraftClient c){
  var dimension=c.world.getDimension();boolean natural=dimension.natural()&&dimension.hasSkyLight()&&dimension.fixedTime().isEmpty();
  if(!natural)return DaylightState.observe(false,false,false,0);
  boolean clock=false;
  for(int i=0;i<c.player.getInventory().size();i++)if(c.player.getInventory().getStack(i).isOf(net.minecraft.item.Items.CLOCK)){clock=true;break;}
  var eye=c.player.getEyePos();
  var sky=c.world.raycast(new net.minecraft.world.RaycastContext(eye,new net.minecraft.util.math.Vec3d(eye.x,c.world.getTopY()+1,eye.z),net.minecraft.world.RaycastContext.ShapeType.COLLIDER,net.minecraft.world.RaycastContext.FluidHandling.ANY,c.player));
  boolean visible=sky.getType()==net.minecraft.util.hit.HitResult.Type.MISS;
  return DaylightState.observe(true,visible,clock,visible||clock?c.world.getTimeOfDay():0);
 }
 public static JsonObject stack(ItemStack stack){var o=new JsonObject();o.addProperty("item",Registries.ITEM.getId(stack.getItem()).toString());o.addProperty("count",stack.getCount());o.addProperty("name",stack.getName().getString());o.addProperty("damage",stack.getDamage());o.addProperty("maxDamage",stack.getMaxDamage());
  var components=new JsonObject();
  for(var type:java.util.List.of(net.minecraft.component.DataComponentTypes.ENCHANTMENTS,net.minecraft.component.DataComponentTypes.STORED_ENCHANTMENTS,net.minecraft.component.DataComponentTypes.POTION_CONTENTS,net.minecraft.component.DataComponentTypes.FOOD,net.minecraft.component.DataComponentTypes.BANNER_PATTERNS)){
   var value=stack.get(type);if(value instanceof net.minecraft.component.type.ItemEnchantmentsComponent enchantments&&enchantments.isEmpty())continue;
   if(value instanceof net.minecraft.component.type.BannerPatternsComponent patterns&&patterns.layers().isEmpty())continue;
   if(value!=null){String text=value.toString();components.addProperty(net.minecraft.registry.Registries.DATA_COMPONENT_TYPE.getId(type).toString(),text.substring(0,Math.min(1000,text.length())));}
  }
  o.add("components",components);return o;}
 public static String screenId(net.minecraft.screen.ScreenHandler handler){
  if(handler instanceof net.minecraft.screen.PlayerScreenHandler)return "minecraft:inventory";
  if(handler instanceof net.minecraft.screen.HorseScreenHandler)return "minecraft:horse";
  return Registries.SCREEN_HANDLER.getId(handler.getType()).toString();
 }
 public static JsonArray stationOptions(MinecraftClient c,String query,int limit){
  var result=new JsonArray();var handler=c.player.currentScreenHandler;
  if(handler instanceof net.minecraft.screen.StonecutterScreenHandler stone){
   var recipes=stone.getAvailableRecipes();var names=recipes.stream().map(r->r.id()+" "+Registries.ITEM.getId(r.value().getResult(c.world.getRegistryManager()).getItem())).toList();
   for(int index:StationOptions.matching(names,query,limit)){var recipe=recipes.get(index);var row=new JsonObject();row.addProperty("buttonId",index);row.addProperty("id",recipe.id().toString());row.add("output",stack(recipe.value().getResult(c.world.getRegistryManager())));result.add(row);}
  }else if(handler instanceof net.minecraft.screen.LoomScreenHandler loom){
   var patterns=loom.getBannerPatterns();var names=patterns.stream().map(p->p.getKey().map(k->k.getValue().toString()).orElse(p.value().assetId().toString())).toList();
   for(int index:StationOptions.matching(names,query,limit)){var row=new JsonObject();row.addProperty("buttonId",index);row.addProperty("id",names.get(index));result.add(row);}
  }
  return result;
 }
 public static JsonArray recipes(MinecraftClient c,String query,int limit){
  if(c.player.currentScreenHandler instanceof net.minecraft.screen.StonecutterScreenHandler||c.player.currentScreenHandler instanceof net.minecraft.screen.LoomScreenHandler)return stationOptions(c,query,limit);
  var p=c.player;
  var recipes=new JsonArray();
  for(var recipe:c.world.getRecipeManager().values().stream().filter(r->p.getRecipeBook().contains(r)&&(query.isBlank()||r.id().toString().contains(query)||Registries.ITEM.getId(r.value().getResult(c.world.getRegistryManager()).getItem()).toString().contains(query))).sorted(java.util.Comparator.comparing(r->r.id().toString())).limit(limit).toList()){
   var row=new JsonObject();row.addProperty("id",recipe.id().toString());row.add("output",stack(recipe.value().getResult(c.world.getRegistryManager())));var ingredients=new JsonArray();
   for(var ingredient:recipe.value().getIngredients()){var choices=new JsonArray();for(var choice:java.util.Arrays.stream(ingredient.getMatchingStacks()).limit(4).toList())choices.add(Registries.ITEM.getId(choice.getItem()).toString());ingredients.add(choices);}
   row.add("ingredients",ingredients);recipes.add(row);
  }
  return recipes;
 }
 public static void append(MinecraftClient c,JsonObject result){
  result.add("daylight",new Gson().toJsonTree(daylight(c)));
  result.add("recentChat",new Gson().toJsonTree(GameChat.CURRENT.snapshot(c.world)));
  result.addProperty("shieldBlockCount",ShieldBlocks.CURRENT.count(c.world));
  var p=c.player;var handler=p.currentScreenHandler;
  result.addProperty("screenHandler",screenId(handler));result.addProperty("screenRevision",handler.getRevision());
  result.addProperty("perspective",c.options.getPerspective().name());result.addProperty("experience",p.experienceLevel);result.addProperty("onFire",p.isOnFire());result.addProperty("inWater",p.isTouchingWater());result.addProperty("air",p.getAir());result.addProperty("riding",p.hasVehicle());result.addProperty("sleeping",p.isSleeping());
  var entities=new JsonArray();
  for(var e:c.world.getOtherEntities(p,p.getBoundingBox().expand(32),e->p.canSee(e)&&e.squaredDistanceTo(p)<=1024).stream().sorted(java.util.Comparator.comparingDouble(e->e.squaredDistanceTo(p))).limit(24).toList()){
   var row=new JsonObject();row.addProperty("entityId",e.getId());row.addProperty("type",Registries.ENTITY_TYPE.getId(e.getType()).toString());row.addProperty("name",e.getName().getString());row.addProperty("x",e.getX());row.addProperty("y",e.getY());row.addProperty("z",e.getZ());
   if(e instanceof net.minecraft.entity.LivingEntity living)row.addProperty("health",living.getHealth());if(e instanceof net.minecraft.entity.ItemEntity drop)row.add("stack",stack(drop.getStack()));entities.add(row);
  }
  result.add("visibleEntities",entities);
  var eye=p.getEyePos();
  var landmarks=SightLandmarks.collect(eye.x,eye.y,eye.z,p.getYaw(),p.getPitch(),(dx,dy,dz)->{
   var hit=c.world.raycast(new net.minecraft.world.RaycastContext(eye,eye.add(dx,dy,dz),net.minecraft.world.RaycastContext.ShapeType.COLLIDER,net.minecraft.world.RaycastContext.FluidHandling.NONE,p));
   if(hit.getType()!=net.minecraft.util.hit.HitResult.Type.BLOCK||!c.world.isChunkLoaded(hit.getBlockPos()))return null;
   var pos=hit.getBlockPos();var state=c.world.getBlockState(pos);
   int priority=state.isIn(net.minecraft.registry.tag.BlockTags.LOGS)?0:state.isIn(net.minecraft.registry.tag.BlockTags.LEAVES)?1:state.hasBlockEntity()?2:3;
   return new SightLandmarks.Hit(pos.getX(),pos.getY(),pos.getZ(),Registries.BLOCK.getId(state.getBlock()).toString(),priority);
  });
  result.add("visibleLandmarks",new Gson().toJsonTree(landmarks));
  result.addProperty("biome",c.world.getBiome(p.getBlockPos()).getKey().map(key->key.getValue().toString()).orElse("unknown"));
  result.addProperty("difficulty",c.world.getDifficulty().getName());
  boolean choiceMenu=handler instanceof net.minecraft.screen.StonecutterScreenHandler||handler instanceof net.minecraft.screen.LoomScreenHandler;
  result.add("knownRecipes",choiceMenu?new JsonArray():recipes(c,"",8));
  result.addProperty("recipeQueryAvailable",true);
  var station=new JsonObject();
  if(handler instanceof net.minecraft.screen.AbstractFurnaceScreenHandler furnace){station.addProperty("cookProgress",furnace.getCookProgress());station.addProperty("fuelProgress",furnace.getFuelProgress());}
  if(handler instanceof net.minecraft.screen.BrewingStandScreenHandler brewing){station.addProperty("brewTime",brewing.getBrewTime());station.addProperty("fuel",brewing.getFuel());}
  if(handler instanceof net.minecraft.screen.EnchantmentScreenHandler enchant){station.add("power",new Gson().toJsonTree(enchant.enchantmentPower));station.add("enchantments",new Gson().toJsonTree(enchant.enchantmentId));station.add("levels",new Gson().toJsonTree(enchant.enchantmentLevel));}
  if(handler instanceof net.minecraft.screen.StonecutterScreenHandler stone){station.addProperty("selectedButtonId",stone.getSelectedRecipe());station.addProperty("optionCount",stone.getAvailableRecipeCount());station.add("options",stationOptions(c,"",8));}
  if(handler instanceof net.minecraft.screen.LoomScreenHandler loom){station.addProperty("selectedButtonId",loom.getSelectedPattern());station.addProperty("optionCount",loom.getBannerPatterns().size());station.add("options",stationOptions(c,"",8));}
  if(handler instanceof net.minecraft.screen.AnvilScreenHandler anvil)station.addProperty("levelCost",anvil.getLevelCost());
  if(handler instanceof net.minecraft.screen.MerchantScreenHandler merchant){var offers=new JsonArray();int i=0;for(var offer:merchant.getRecipes()){if(i>=32)break;var row=new JsonObject();row.addProperty("index",i++);row.add("buy",stack(offer.getDisplayedFirstBuyItem()));row.add("buy2",stack(offer.getDisplayedSecondBuyItem()));row.add("sell",stack(offer.getSellItem()));row.addProperty("disabled",offer.isDisabled());offers.add(row);}station.add("offers",offers);}
  result.add("station",station);
 }
}
