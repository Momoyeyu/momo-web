package dev.momo.task;
import java.util.ArrayList;
import net.minecraft.client.MinecraftClient;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.effect.StatusEffectCategory;
import net.minecraft.entity.effect.StatusEffects;
/** Shared food inspection for an explicit eat task and the local survival reflex. */
final class FoodInventory {
 static int find(MinecraftClient c,int limit){
  var choices=new ArrayList<FoodChoice.Candidate>();
  for(int i=0;i<Math.min(limit,36);i++){
   var food=c.player.getInventory().getStack(i).get(DataComponentTypes.FOOD);if(food==null)continue;
   boolean unsafe=false,hunger=false;
   for(var effect:food.effects()){
    if(effect.probability()<=0)continue;
    var type=effect.effect().getEffectType();
    if(type.matchesKey(StatusEffects.HUNGER.getKey().orElseThrow()))hunger=true;
    else if(type.value().getCategory()==StatusEffectCategory.HARMFUL)unsafe=true;
   }
   choices.add(new FoodChoice.Candidate(i,food.nutrition(),food.saturation(),unsafe,hunger));
  }
  return FoodChoice.choose(choices,c.player.getHungerManager().getFoodLevel());
 }
}
