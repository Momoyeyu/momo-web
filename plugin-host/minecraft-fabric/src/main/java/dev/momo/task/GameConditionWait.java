package dev.momo.task;
import com.google.gson.JsonObject;
import java.util.Map;
import net.minecraft.client.MinecraftClient;
/** Only samples the authorized current body; outer runtime arbitrates reflexes. */
final class GameConditionWait {
 static TaskRuntime.Work create(JsonObject args){
  var c=MinecraftClient.getInstance();
  String condition=args.get("condition").getAsString();
  return new ConditionWait(condition,args.has("minimum")?args.get("minimum").getAsInt():null,args.get("ticks").getAsInt(),()->{
   // CompanionClient checks world/account/epoch before every task tick. Read
   // the current body here, not an entity captured while a plan was queued.
   var player=c.player;if(c.world==null||player==null||!player.isAlive())throw new TaskRuntime.Rejected("world_unavailable");
   return switch(condition){case "health"->Map.of("health",player.getHealth());case "food"->Map.of("food",player.getHungerManager().getFoodLevel());default->Map.of("daylight",GameObservation.daylight(c));};
  });
 }
}
