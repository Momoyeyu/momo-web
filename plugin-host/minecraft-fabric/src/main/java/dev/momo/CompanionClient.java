package dev.momo;

import com.google.gson.*;
import dev.momo.mixin.GameplayInputAccess;
import dev.momo.task.TaskRuntime;
import dev.momo.task.BaritoneNavigator;
import dev.momo.task.GameSkills;
import dev.momo.task.GameObservation;
import dev.momo.task.SurvivalController;
import dev.momo.task.SurvivalPolicy;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.*;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.minecraft.client.MinecraftClient;

/** Existing-client bridge. All Minecraft access runs on the game thread. */
public final class CompanionClient implements ClientModInitializer {
 private long epoch = -1, deadline;
 private String boundWorld, boundAccount;
 private final TaskRuntime tasks=new TaskRuntime();
 private final SurvivalController survival=new SurvivalController();
 private String taskWorld, taskAccount;
 private net.minecraft.client.world.ClientWorld taskWorldInstance;
 private boolean taskPaused,physicalTakeover,guardAuthorized;
 private long gameLeaseUntil;
 public static boolean controlling(){return instance!=null&&(instance.tasks.active()||instance.playing||instance.guardAuthorized);}
 public static void physicalInput(){if(instance!=null&&controlling())instance.physicalTakeover=true;}
 private static CompanionClient instance;
 private boolean playing,mining,using,attacking,drivingInput;
 private int useTicks;
 public static boolean suppressVanillaBreaking(){return instance!=null && instance.playing && instance.mining && !instance.drivingInput;}
 private long backgroundUntil;
 public static boolean suppressAutoPause(){return instance!=null && System.nanoTime()<instance.backgroundUntil && !MinecraftClient.getInstance().isWindowFocused();}
 private java.nio.file.Path rendezvous;
 private HttpServer server;
 private ExecutorService executor;
 private final Gson gson = new Gson();
 private record CapturedReply(JsonObject body,net.minecraft.client.texture.NativeImage frame){}
 public void onInitializeClient() {
  instance=this;
  String token = System.getProperty("momo.bridge.token", "");
  if (token.length() < 32) token = java.util.UUID.randomUUID().toString()+java.util.UUID.randomUUID();
  final String sessionToken = token;
  try {
   server = HttpServer.create(new InetSocketAddress("127.0.0.1", Integer.getInteger("momo.bridge.port", 0)), 8);
   executor = new ThreadPoolExecutor(4,4,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(16));
   server.setExecutor(executor);
   server.createContext("/command", exchange -> {
    byte[] response;
    int code = 200;
    try {
     String auth = exchange.getRequestHeaders().getFirst("Authorization");
     if (!"POST".equals(exchange.getRequestMethod()) || auth == null || !MessageDigest.isEqual(auth.getBytes(StandardCharsets.UTF_8), ("Bearer " + sessionToken).getBytes(StandardCharsets.UTF_8))) throw new IllegalArgumentException("Unauthorized");
     byte[] body = exchange.getRequestBody().readNBytes(4097);
     if (body.length > 4096) throw new IllegalArgumentException("Too large");
     JsonObject command = JsonParser.parseString(new String(body, StandardCharsets.UTF_8)).getAsJsonObject();
     long expires = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
     CompletableFuture<CapturedReply> result = new CompletableFuture<>();
     MinecraftClient.getInstance().execute(() -> {
      var frame=new java.util.concurrent.atomic.AtomicReference<net.minecraft.client.texture.NativeImage>();
      try {
       if (System.nanoTime() > expires || result.isCancelled()) throw new IllegalStateException("Expired");
       var bodyResult=command(command,frame::set);
       if(!result.complete(new CapturedReply(bodyResult,frame.get()))&&frame.get()!=null)frame.get().close();
      } catch (Exception error) {if(frame.get()!=null)frame.get().close();result.completeExceptionally(error);}
     });
     CapturedReply reply;
     try{reply=result.get(2500,TimeUnit.MILLISECONDS);}catch(Exception error){result.cancel(false);throw error;}
     // GL capture stays on the client thread; scaling/PNG encoding never blocks its ticks.
     try(var raw=reply.frame()){
      if(raw!=null){
       int width=Math.min(960,raw.getWidth()),height=Math.max(1,raw.getHeight()*width/raw.getWidth());
       try(var scaled=new net.minecraft.client.texture.NativeImage(width,height,false)){
        raw.resizeSubRectTo(0,0,raw.getWidth(),raw.getHeight(),scaled);
        byte[] png=scaled.getBytes();if(png.length>4000000)throw new IllegalStateException("Frame too large");
        reply.body().addProperty("frame","data:image/png;base64,"+java.util.Base64.getEncoder().encodeToString(png));
       }
      }
      response=gson.toJson(reply.body()).getBytes(StandardCharsets.UTF_8);
     }
    } catch (Exception error) { code = 400; response = "{\"error\":\"Command rejected\"}".getBytes(StandardCharsets.UTF_8); }
    exchange.getResponseHeaders().set("Content-Type", "application/json");
    exchange.sendResponseHeaders(code, response.length);
    try (var out = exchange.getResponseBody()) { out.write(response); }
    exchange.close();
   });
   server.start();
   var directory=java.nio.file.Path.of(System.getProperty("user.home"),".momo","minecraft-bridge");
   java.nio.file.Files.createDirectories(directory);
   java.nio.file.Files.setPosixFilePermissions(directory,java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
   rendezvous=directory.resolve(ProcessHandle.current().pid()+".json");
   var discovery=new JsonObject();discovery.addProperty("port",server.getAddress().getPort());discovery.addProperty("token",sessionToken);discovery.addProperty("pid",ProcessHandle.current().pid());
   java.nio.file.Files.deleteIfExists(rendezvous);
   java.nio.file.Files.createFile(rendezvous,java.nio.file.attribute.PosixFilePermissions.asFileAttribute(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")));
   java.nio.file.Files.writeString(rendezvous,gson.toJson(discovery));
   ClientTickEvents.END_CLIENT_TICK.register(this::tick);
   ClientLifecycleEvents.CLIENT_STOPPING.register(client -> { release(client); restorePause(client); server.stop(0); executor.shutdownNow(); try { java.nio.file.Files.deleteIfExists(rendezvous); } catch (Exception ignored) {} });
  } catch (Exception error) { if (server != null) server.stop(0); if (executor != null) executor.shutdownNow(); }
 }
 private void restorePause(MinecraftClient client) {
  boolean controlled=backgroundUntil!=0;
  backgroundUntil=0;
  if(controlled && client.player!=null && client.currentScreen==null && client.options.pauseOnLostFocus && !client.isWindowFocused())client.openGameMenu(false);
 }
 private void backgroundControl(MinecraftClient client) {
  // Suppress only automatic unfocused pause; never mutate or serialize preferences.
  backgroundUntil=System.nanoTime()+TimeUnit.SECONDS.toNanos(60);
 }
 private void release(MinecraftClient client) {
  survival.stop();tasks.stop("control_released");taskPaused=false;guardAuthorized=false;gameLeaseUntil=0;
  if(mining && client.interactionManager!=null)client.interactionManager.cancelBlockBreaking();
  if(using && client.interactionManager!=null && client.player!=null && client.player.isUsingItem())client.interactionManager.stopUsingItem(client.player);
  playing = mining = using = attacking = false;
  boundWorld = null; boundAccount = null; deadline = 0;
  client.options.forwardKey.setPressed(false); client.options.backKey.setPressed(false);
  client.options.leftKey.setPressed(false); client.options.rightKey.setPressed(false);
  client.options.jumpKey.setPressed(false); client.options.sneakKey.setPressed(false);
  client.options.sprintKey.setPressed(false); client.options.attackKey.setPressed(false); client.options.useKey.setPressed(false);
 }
 private boolean isCommandText(String text){
  String stripped=text.stripLeading(),prefix=baritone.api.BaritoneAPI.getSettings().prefix.value;
  return stripped.startsWith("/")||stripped.startsWith("#")||(!prefix.isEmpty()&&stripped.startsWith(prefix));
 }
 private String serverName(MinecraftClient client){return client.getCurrentServerEntry()!=null?client.getCurrentServerEntry().name:"Minecraft";}
 private String worldScope(MinecraftClient client){
  String server=client.getCurrentServerEntry()!=null?client.getCurrentServerEntry().address:"local";
  if(client.getServer()!=null){
   String path=client.getServer().getSavePath(net.minecraft.util.WorldSavePath.ROOT).toAbsolutePath().normalize().toString();
   try{server="local:"+java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(path.getBytes(StandardCharsets.UTF_8))).substring(0,24);}catch(java.security.NoSuchAlgorithmException error){throw new IllegalStateException(error);}
  }
  return server;
 }
 private JsonObject command(JsonObject command,java.util.function.Consumer<net.minecraft.client.texture.NativeImage> capture) throws Exception {
  MinecraftClient client = MinecraftClient.getInstance();
  String type = command.get("type").getAsString();
  if ("ping".equals(type)) { JsonObject ready = new JsonObject(); ready.addProperty("ready", true); ready.addProperty("protocol", 1);
   if (client.player!=null && client.world!=null) {
    String scope=worldScope(client);
    ready.addProperty("world",scope);ready.addProperty("dimension",client.world.getRegistryKey().getValue().toString());ready.addProperty("worldName",client.getServer()!=null?client.getServer().getSaveProperties().getLevelName():serverName(client));ready.addProperty("account",client.player.getUuidAsString());ready.addProperty("playerName",client.player.getName().getString());
   }
   return ready; }
  long version = command.get("epoch").getAsLong();
  if (version < epoch) throw new IllegalArgumentException("Revoked");
  JsonElement retiredTasks=null;
  if (version > epoch) {
   release(client);restorePause(client);
   retiredTasks=gson.toJsonTree(tasks.recentSnapshots());
   tasks.resetSession();epoch=version;
  }
  JsonObject result = new JsonObject(); result.addProperty("epoch", epoch);
  if(retiredTasks!=null)result.add("retiredTasks",retiredTasks);
  if ("stop".equals(type)) { release(client); restorePause(client); result.addProperty("stopped", tasks.stopConfirmed()); result.addProperty("heldControls", tasks.stopConfirmed()?0:-1); return result; }
  if (client.player == null || client.world == null) throw new IllegalStateException("Join an authorized world first");
  String world = worldScope(client);
  String account = client.player.getUuidAsString();
  if (!world.equals(command.get("world").getAsString()) || !account.equals(command.get("account").getAsString())) { release(client); restorePause(client); throw new IllegalArgumentException("Identity mismatch"); }
  if(backgroundUntil!=0) backgroundControl(client);
  result.addProperty("world", world);result.addProperty("dimension",client.world.getRegistryKey().getValue().toString()); result.addProperty("account", account);
  switch (type) {
   case "capabilities" -> {
    result.addProperty("protocol",1);result.addProperty("taskProtocol",1);
    result.addProperty("navigation",BaritoneNavigator.available());result.addProperty("navigationBackend","baritone-1.11.3");
    result.add("skills",gson.toJsonTree(GameSkills.NAMES));result.add("skillDefinitions",dev.momo.task.SkillArguments.contract());
   }
   case "recipes" -> {
    String query=command.get("query").getAsString();if(query.length()>64||query.chars().anyMatch(c->c<32))throw new IllegalArgumentException("Invalid query");
    result.add("recipes",GameObservation.recipes(client,query,16));
   }
   case "submit" -> {
    String skill=command.get("skill").getAsString();
    if(client.currentScreen!=null&&!(client.currentScreen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen<?>)&&!skill.equals("respawn")){result.addProperty("accepted",false);result.addProperty("error","MENU_OPEN");return result;}
    if(playing){result.addProperty("accepted",false);result.addProperty("error","BODY_BUSY");return result;}
    String id=command.get("taskId").getAsString();
    JsonObject args=command.has("args")?command.getAsJsonObject("args"):new JsonObject();
    if(skill.equals("navigate")&&!command.has("args"))for(String key:new String[]{"x","y","z"})args.add(key,command.get(key));
    boolean accepted;
    try{var work=GameSkills.create(skill,args);accepted=tasks.submit(id,skill,args.toString(),work,System.nanoTime()/1000000,command.get("leaseMs").getAsLong());}
    catch(IllegalArgumentException|IllegalStateException error){result.addProperty("accepted",false);result.addProperty("error","TASK_REJECTED");return result;}
    taskWorld=world;taskAccount=account;taskWorldInstance=client.world;guardAuthorized=true;gameLeaseUntil=System.nanoTime()/1000000+command.get("leaseMs").getAsLong();backgroundControl(client);
    result.addProperty("accepted",accepted);result.add("task",gson.toJsonTree(tasks.snapshot(id)));
   }
   case "task" -> {
    if(command.has("taskId")){try{result.add("task",gson.toJsonTree(tasks.snapshot(command.get("taskId").getAsString())));}catch(IllegalArgumentException error){result.addProperty("error","TASK_NOT_FOUND");}}
    else result.add("tasks",gson.toJsonTree(tasks.snapshots()));
   }
   case "events" -> result.add("events",gson.toJsonTree(tasks.events(command.get("after").getAsLong())));
   case "heartbeat" -> {long now=System.nanoTime()/1000000,lease=command.get("leaseMs").getAsLong();tasks.heartbeat(now,lease);if(guardAuthorized)gameLeaseUntil=now+lease;result.addProperty("active",tasks.active());result.addProperty("controlPaused",taskPaused);}
   case "pause" -> {survival.stop();taskPaused=true;tasks.pause();result.addProperty("paused",true);}
   case "resumeTask" -> {taskPaused=false;guardAuthorized=taskWorld!=null;gameLeaseUntil=System.nanoTime()/1000000+10000;if(client.currentScreen==null)tasks.resume();result.addProperty("paused",false);}
   case "cancel" -> {
    tasks.cancel(command.get("taskId").getAsString(),"requested");
    result.add("task",gson.toJsonTree(tasks.snapshot(command.get("taskId").getAsString())));
    if(!tasks.active()){release(client);restorePause(client);}
   }
   case "observe" -> {

    capture.accept(net.minecraft.client.util.ScreenshotRecorder.takeScreenshot(client.getFramebuffer()));
    GameObservation.append(client,result);
    result.addProperty("observedAt", System.currentTimeMillis());
    result.addProperty("x",client.player.getX()); result.addProperty("y",client.player.getY()); result.addProperty("z",client.player.getZ());
    result.addProperty("yaw",client.player.getYaw()); result.addProperty("pitch",client.player.getPitch());
    result.addProperty("screen",client.currentScreen==null?"world":
     client.currentScreen instanceof net.minecraft.client.gui.screen.GameMenuScreen?"pause":
     client.currentScreen instanceof net.minecraft.client.gui.screen.ingame.InventoryScreen?"inventory":
     client.currentScreen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen<?>?"container":
     client.currentScreen instanceof net.minecraft.client.gui.screen.DeathScreen?"death":"menu");
    JsonObject cursor=new JsonObject();
    var stack=client.player.currentScreenHandler.getCursorStack();
    cursor.addProperty("item",net.minecraft.registry.Registries.ITEM.getId(stack.getItem()).toString());
    cursor.addProperty("count",stack.getCount()); result.add("cursor",cursor);
    result.addProperty("food",client.player.getHungerManager().getFoodLevel());
    result.addProperty("gameMode",client.interactionManager.getCurrentGameMode().getName());
    JsonArray drops=new JsonArray();
    var nearby=client.world.getEntitiesByClass(net.minecraft.entity.ItemEntity.class,client.player.getBoundingBox().expand(6),item->!item.getStack().isEmpty() && item.squaredDistanceTo(client.player)<=36);
    nearby.sort(java.util.Comparator.comparingDouble(item->item.squaredDistanceTo(client.player)));
    for(var item:nearby.subList(0,Math.min(8,nearby.size()))) {
     JsonObject drop=new JsonObject();drop.addProperty("item",net.minecraft.registry.Registries.ITEM.getId(item.getStack().getItem()).toString());drop.addProperty("count",item.getStack().getCount());
     drop.addProperty("x",Math.round(item.getX()*100)/100.0);drop.addProperty("y",Math.round(item.getY()*100)/100.0);drop.addProperty("z",Math.round(item.getZ()*100)/100.0);drop.addProperty("visible",client.player.canSee(item));drops.add(drop);
    }
    result.add("nearbyDrops",drops);
    JsonArray slots=new JsonArray(),emptySlots=new JsonArray();
    for(var slot:client.player.currentScreenHandler.slots){
     if(slot.getStack().isEmpty()){emptySlots.add(slot.id);continue;}
     JsonObject item=GameObservation.stack(slot.getStack()); item.addProperty("id",slot.id);slots.add(item);
    }
    result.add("slots",slots);
    result.add("emptySlots",emptySlots);
    result.addProperty("selectedHotbar", client.player.getInventory().selectedSlot);
    if(client.crosshairTarget instanceof net.minecraft.util.hit.BlockHitResult hit && hit.getType()==net.minecraft.util.hit.HitResult.Type.BLOCK) {
     result.addProperty("targetBlock",net.minecraft.registry.Registries.BLOCK.getId(client.world.getBlockState(hit.getBlockPos()).getBlock()).toString());
    }
    // Local visible geometry, like AIRI's block observations. Never expose
    // unloaded terrain or resources hidden behind another solid block.
    var eye=client.player.getEyePos();
    var candidates=new java.util.ArrayList<net.minecraft.util.math.BlockPos>();
    var origin=client.player.getBlockPos();
    for(var pos:net.minecraft.util.math.BlockPos.iterate(origin.add(-5,-3,-5),origin.add(5,4,5))) {
     if(!client.world.isChunkLoaded(pos) || client.world.getBlockState(pos).isAir())continue;
     var center=pos.toCenterPos();
     if(eye.squaredDistanceTo(center)>36)continue;
     var ray=client.world.raycast(new net.minecraft.world.RaycastContext(eye,center,net.minecraft.world.RaycastContext.ShapeType.OUTLINE,net.minecraft.world.RaycastContext.FluidHandling.NONE,client.player));
     if(ray.getType()==net.minecraft.util.hit.HitResult.Type.BLOCK && ray.getBlockPos().equals(pos))candidates.add(pos.toImmutable());
    }
    candidates.sort(java.util.Comparator.<net.minecraft.util.math.BlockPos>comparingInt(pos->{var block=client.world.getBlockState(pos);return block.isIn(net.minecraft.registry.tag.BlockTags.LOGS)?0:block.isIn(net.minecraft.registry.tag.BlockTags.LEAVES)||block.isOf(net.minecraft.block.Blocks.CRAFTING_TABLE)||block.hasBlockEntity()?1:2;}).thenComparingDouble(pos->eye.squaredDistanceTo(pos.toCenterPos())));
    JsonArray visible=new JsonArray();
    for(var pos:candidates.subList(0,Math.min(8,candidates.size()))) {
     var offset=pos.toCenterPos().subtract(eye);JsonObject block=new JsonObject();
     block.addProperty("block",net.minecraft.registry.Registries.BLOCK.getId(client.world.getBlockState(pos).getBlock()).toString());
     block.addProperty("x",pos.getX());block.addProperty("y",pos.getY());block.addProperty("z",pos.getZ());
     block.addProperty("distance",Math.round(offset.length()*100)/100.0);
     block.addProperty("lookYaw",Math.round(net.minecraft.util.math.MathHelper.wrapDegrees(Math.toDegrees(Math.atan2(-offset.x,offset.z))-client.player.getYaw())*10)/10.0);
     block.addProperty("lookPitch",Math.round((Math.toDegrees(-Math.atan2(offset.y,Math.sqrt(offset.x*offset.x+offset.z*offset.z)))-client.player.getPitch())*10)/10.0);
     visible.add(block);
    }
    result.add("visibleBlocks",visible);
    result.addProperty("health", client.player.getHealth());
    JsonArray players = new JsonArray();
    for (var player : client.world.getPlayers()) if (player != client.player && client.player.canSee(player) && client.player.squaredDistanceTo(player) <= 1024) players.add(player.getName().getString());
    result.add("visiblePlayers", players);
   }
   case "play" -> play(client, command, world, account);
   case "chat" -> {
    String text = command.get("text").getAsString();
    if (text.isBlank() || text.length() > 256 || isCommandText(text) || text.chars().anyMatch(c -> c < 32)) throw new IllegalArgumentException("Invalid chat");
    client.player.networkHandler.sendChatMessage(text);
   }
   case "follow" -> {
    if(playing)throw new IllegalStateException("Another action owns the body");
    String name=command.get("player").getAsString();
    if(!name.matches("[A-Za-z0-9_]{1,16}"))throw new IllegalArgumentException("Invalid player");
    var player=client.world.getPlayers().stream().filter(p->p!=client.player&&p.getName().getString().equals(name)&&client.player.canSee(p)).findFirst().orElseThrow(()->new IllegalArgumentException("Player is not visible"));
    var args=new JsonObject();args.addProperty("entityId",player.getId());String id="follow-"+java.util.UUID.randomUUID();
    tasks.submit(id,"follow",args.toString(),GameSkills.create("follow",args),System.nanoTime()/1000000,10000);
    taskWorld=world;taskAccount=account;taskWorldInstance=client.world;backgroundControl(client);
    result.addProperty("accepted",true);result.add("task",gson.toJsonTree(tasks.snapshot(id)));
   }
   default -> throw new IllegalArgumentException("Unsupported command");
  }
  return result;
 }
 private void play(MinecraftClient c,JsonObject cmd,String world,String account) {
  if(tasks.active())throw new IllegalStateException("Navigation owns the body");
  String key=cmd.get("control").getAsString();
  int duration=cmd.get("durationMs").getAsInt();
  if(duration<1 || duration>10000 || c.interactionManager==null) throw new IllegalArgumentException("Invalid input");
  backgroundControl(c);
  release(c);
  var p=c.player;
  if(key.equals("respawn") && !p.isAlive()) {p.requestRespawn();return;}
  if(key.equals("screenClick") || key.equals("screenScroll") || key.equals("screenText") || key.equals("screenKey")) {
   if(c.currentScreen==null)throw new IllegalStateException("No open game screen");
   double x=cmd.get("x").getAsDouble(), y=cmd.get("y").getAsDouble();
   if(!Double.isFinite(x)||!Double.isFinite(y)||x<0||x>1||y<0||y>1)throw new IllegalArgumentException("Invalid screen coordinate");
   x*=c.currentScreen.width;y*=c.currentScreen.height;
   switch(key) {
    case "screenClick" -> c.currentScreen.mouseClicked(x,y,cmd.get("button").getAsInt());
    case "screenScroll" -> c.currentScreen.mouseScrolled(x,y,0,cmd.get("scroll").getAsDouble());
    case "screenText" -> {
     String text=cmd.get("text").getAsString();
     if(text.length()>256||isCommandText(text)||text.chars().anyMatch(ch->ch<32))throw new IllegalArgumentException("Invalid game text");
     for(char ch:text.toCharArray())c.currentScreen.charTyped(ch,0);
    }
    case "screenKey" -> {
     int code=switch(cmd.get("key").getAsString()) {
      case "enter" -> 257; case "backspace" -> 259;case "tab" -> 258;
      case "left" -> 263;case "right" -> 262;case "up" -> 265;case "down" -> 264;
      default -> throw new IllegalArgumentException("Invalid screen key");
     };
     c.currentScreen.keyPressed(code,0,0);
    }
   }
   return;
  }
  if(key.equals("resume") && c.currentScreen instanceof net.minecraft.client.gui.screen.GameMenuScreen){c.setScreen(null);return;}
  if(c.currentScreen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen<?>){
   if(key.equals("close")) {p.closeHandledScreen();return;}
   if(!key.equals("slot")&&!key.equals("quickMove")) throw new IllegalStateException("Inventory open");
   int index=cmd.get("slot").getAsInt(), button=cmd.get("button").getAsInt();
   if(index<0||index>=p.currentScreenHandler.slots.size()||button<0||button>1)throw new IllegalArgumentException("Invalid slot");
   c.interactionManager.clickSlot(p.currentScreenHandler.syncId,index,button,key.equals("slot")?net.minecraft.screen.slot.SlotActionType.PICKUP:net.minecraft.screen.slot.SlotActionType.QUICK_MOVE,p);
   return;
  }
  if(c.currentScreen!=null || !p.isAlive())throw new IllegalStateException("Game not active");
  var o=c.options;
  switch(key){
   case "look" -> {float yaw=cmd.get("yaw").getAsFloat(),pitch=cmd.get("pitch").getAsFloat();if(!Float.isFinite(yaw)||!Float.isFinite(pitch)||Math.abs(yaw)>180||Math.abs(pitch)>90)throw new IllegalArgumentException("Invalid look");p.changeLookDirection(yaw/0.15,pitch/0.15);return;}
   case "hotbar" -> {int slot=cmd.get("slot").getAsInt();if(slot<0||slot>8)throw new IllegalArgumentException("Invalid hotbar slot");p.getInventory().selectedSlot=slot;p.networkHandler.sendPacket(new net.minecraft.network.packet.c2s.play.UpdateSelectedSlotC2SPacket(slot));return;}
   case "inventory" -> {c.setScreen(new net.minecraft.client.gui.screen.ingame.InventoryScreen(p));return;}
   case "drop" -> {p.networkHandler.sendPacket(new net.minecraft.network.packet.c2s.play.UpdateSelectedSlotC2SPacket(p.getInventory().selectedSlot));p.dropSelectedItem(false);return;}
   default -> {}
  }
  var binding=switch(key){
   case "forward","sprint" -> o.forwardKey;case "back" -> o.backKey;case "left" -> o.leftKey;case "right" -> o.rightKey;
   case "jump" -> o.jumpKey;case "sneak" -> o.sneakKey;case "attack","mine" -> o.attackKey;
   case "use","eat" -> o.useKey;case "swapHands" -> o.swapHandsKey;default -> throw new IllegalArgumentException("Unknown control");
  };
  if(key.equals("swapHands"))
   net.minecraft.client.option.KeyBinding.onKeyPressed(net.minecraft.client.util.InputUtil.fromTranslationKey(binding.getBoundKeyTranslationKey()));
  if(key.equals("swapHands"))return;
  binding.setPressed(true); if(key.equals("sprint"))o.sprintKey.setPressed(true);
  if(cmd.has("held")) for(var extra:cmd.getAsJsonArray("held")) {
   switch(extra.getAsString()) {
    case "forward" -> o.forwardKey.setPressed(true);
    case "back" -> o.backKey.setPressed(true);
    case "left" -> o.leftKey.setPressed(true);
    case "right" -> o.rightKey.setPressed(true);
    case "sprint" -> o.sprintKey.setPressed(true);
    case "sneak" -> o.sneakKey.setPressed(true);
    case "jump" -> o.jumpKey.setPressed(true);
   }
  }
  mining=key.equals("mine")||key.equals("attack");attacking=key.equals("attack");using=key.equals("use")||key.equals("eat");useTicks=0;
  playing=true; boundWorld=world; boundAccount=account;deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(duration);
 }
 private void tick(MinecraftClient client) {
  dev.momo.task.PickupLedger.CURRENT.changeWorld(client.world);
  if(physicalTakeover){physicalTakeover=false;tasks.stop("manual_takeover");tasks.notice("manual_takeover");release(client);taskPaused=true;tasks.pause();restorePause(client);return;}
  long localNow=System.nanoTime()/1000000;
  if(guardAuthorized&&!tasks.active()){
   if(localNow>=gameLeaseUntil||client.player==null||client.world!=taskWorldInstance||!client.player.isAlive()||!client.player.getUuidAsString().equals(taskAccount)){tasks.notice("scene_or_life_changed");release(client);restorePause(client);return;}
   if(!taskPaused&&client.currentScreen==null){var reflex=survival.choose();if(reflex!=SurvivalPolicy.Mode.NONE){survival.drive(reflex);return;}}
   survival.stop();
   // The renewable body lease owns idle survival, not the legacy 60s input timer.
   return;
  }
  if(tasks.active()){
   String currentWorld=client.world==null?"":worldScope(client);
   if(client.player==null||(!client.player.isAlive()&&!tasks.snapshots().stream().anyMatch(t->t.skill().equals("respawn")&&(t.state().equals("running")||t.state().equals("queued"))))||(taskWorldInstance!=client.world||!taskWorld.equals(currentWorld))||!taskAccount.equals(client.player.getUuidAsString())){tasks.stop("identity_or_life_changed");release(client);restorePause(client);return;}
   if(client.currentScreen!=null&&!tasks.acceptsScreen(client.currentScreen)){tasks.pause();tasks.tick(System.nanoTime()/1000000);return;}
   if(!taskPaused&&client.currentScreen==null){
    var reflex=survival.choose();
    if(reflex!=SurvivalPolicy.Mode.NONE){tasks.pause();tasks.tick(System.nanoTime()/1000000);if(tasks.active())survival.drive(reflex);else survival.stop();return;}
   }
   survival.stop();
   if(!taskPaused)tasks.resume();
   tasks.tick(System.nanoTime()/1000000);
   return;
  }
  if(backgroundUntil!=0 && (System.nanoTime()>=backgroundUntil || client.player==null || client.world==null)) {release(client);restorePause(client);}
  if(playing){
   if(System.nanoTime()>=deadline||client.player==null||!client.player.isAlive()||client.world==null||client.currentScreen!=null||
      !client.player.getUuidAsString().equals(boundAccount)||!worldScope(client).equals(boundWorld)) {release(client);return;}
   var input=(GameplayInputAccess)client;
   drivingInput=true;
   try {
    if(mining) {
     if(attacking && client.crosshairTarget instanceof net.minecraft.util.hit.EntityHitResult && client.player.getAttackCooldownProgress(0)>=1)input.momo$attack();
     else input.momo$breakBlock(true);
    }
    if(using && useTicks++%4==0 && !client.player.isUsingItem())input.momo$useItem();
   } finally {drivingInput=false;}
   return;
  }
 }
}
