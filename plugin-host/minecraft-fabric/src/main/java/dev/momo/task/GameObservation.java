package dev.momo.task;
import com.google.gson.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.registry.Registries;
import net.minecraft.item.ItemStack;

/** Bounded normal-player facts; no hidden entities, underground scans or server privileges. */
public final class GameObservation {
 private static JsonObject stack(ItemStack stack){var o=new JsonObject();o.addProperty("item",Registries.ITEM.getId(stack.getItem()).toString());o.addProperty("count",stack.getCount());o.addProperty("damage",stack.getDamage());o.addProperty("maxDamage",stack.getMaxDamage());return o;}
 public static String screenId(net.minecraft.screen.ScreenHandler handler){
  if(handler instanceof net.minecraft.screen.PlayerScreenHandler)return "minecraft:inventory";
  return Registries.SCREEN_HANDLER.getId(handler.getType()).toString();
 }
 public static void append(MinecraftClient c,JsonObject result){
  var p=c.player;var handler=p.currentScreenHandler;
  result.addProperty("screenHandler",screenId(handler));result.addProperty("screenRevision",handler.getRevision());
  result.addProperty("experience",p.experienceLevel);result.addProperty("onFire",p.isOnFire());result.addProperty("inWater",p.isTouchingWater());result.addProperty("air",p.getAir());result.addProperty("riding",p.hasVehicle());result.addProperty("sleeping",p.isSleeping());
  var entities=new JsonArray();
  for(var e:c.world.getOtherEntities(p,p.getBoundingBox().expand(32),e->p.canSee(e)&&e.squaredDistanceTo(p)<=1024).stream().sorted(java.util.Comparator.comparingDouble(e->e.squaredDistanceTo(p))).limit(24).toList()){
   var row=new JsonObject();row.addProperty("entityId",e.getId());row.addProperty("type",Registries.ENTITY_TYPE.getId(e.getType()).toString());row.addProperty("name",e.getName().getString());row.addProperty("x",e.getX());row.addProperty("y",e.getY());row.addProperty("z",e.getZ());
   if(e instanceof net.minecraft.entity.LivingEntity living)row.addProperty("health",living.getHealth());entities.add(row);
  }
  result.add("visibleEntities",entities);
  var recipes=new JsonArray();
  for(var recipe:c.world.getRecipeManager().values().stream().filter(r->p.getRecipeBook().contains(r)).sorted(java.util.Comparator.comparing(r->r.id().toString())).limit(64).toList()){
   var row=new JsonObject();row.addProperty("id",recipe.id().toString());row.add("output",stack(recipe.value().getResult(c.world.getRegistryManager())));var ingredients=new JsonArray();
   for(var ingredient:recipe.value().getIngredients()){var choices=new JsonArray();for(var choice:java.util.Arrays.stream(ingredient.getMatchingStacks()).limit(8).toList())choices.add(Registries.ITEM.getId(choice.getItem()).toString());ingredients.add(choices);}
   row.add("ingredients",ingredients);recipes.add(row);
  }
  result.add("knownRecipes",recipes);
  var station=new JsonObject();
  if(handler instanceof net.minecraft.screen.AbstractFurnaceScreenHandler furnace){station.addProperty("cookProgress",furnace.getCookProgress());station.addProperty("fuelProgress",furnace.getFuelProgress());}
  if(handler instanceof net.minecraft.screen.BrewingStandScreenHandler brewing){station.addProperty("brewTime",brewing.getBrewTime());station.addProperty("fuel",brewing.getFuel());}
  if(handler instanceof net.minecraft.screen.EnchantmentScreenHandler enchant){station.add("power",new Gson().toJsonTree(enchant.enchantmentPower));station.add("enchantments",new Gson().toJsonTree(enchant.enchantmentId));station.add("levels",new Gson().toJsonTree(enchant.enchantmentLevel));}
  if(handler instanceof net.minecraft.screen.AnvilScreenHandler anvil)station.addProperty("levelCost",anvil.getLevelCost());
  if(handler instanceof net.minecraft.screen.MerchantScreenHandler merchant){var offers=new JsonArray();int i=0;for(var offer:merchant.getRecipes()){if(i>=32)break;var row=new JsonObject();row.addProperty("index",i++);row.add("buy",stack(offer.getDisplayedFirstBuyItem()));row.add("buy2",stack(offer.getDisplayedSecondBuyItem()));row.add("sell",stack(offer.getSellItem()));row.addProperty("disabled",offer.isDisabled());offers.add(row);}station.add("offers",offers);}
  result.add("station",station);
 }
}
