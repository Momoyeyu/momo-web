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
 private long epoch = -1;
 private String boundWorld, boundAccount;
 private final TaskRuntime tasks=new TaskRuntime();
 private final dev.momo.task.ControlLifetime controlLease=new dev.momo.task.ControlLifetime();
 private final dev.momo.task.PhysicalInputState physicalKeys=new dev.momo.task.PhysicalInputState();
 private final SurvivalController survival=new SurvivalController();
 private String taskWorld, taskAccount;
 private net.minecraft.client.world.ClientWorld taskWorldInstance;
 private boolean physicalTakeover,sceneObservationRequired;
 private long physicalAt;
 private net.minecraft.client.gui.screen.Screen ownedScreen;
 private dev.momo.task.InventoryReceipts.WindowRequest inventoryRequest;
 private final dev.momo.task.PauseBarrier pauseBarrier=new dev.momo.task.PauseBarrier();
 private long focusResumeDeadline;
 public static boolean controlling(){return instance!=null&&instance.controlLease.controlling(instance.tasks.active());}
 public static void physicalKey(int key,int scan,boolean down){if(instance!=null)instance.physicalKeys.key(key,scan,down);}
 public static void physicalButton(int button,boolean down){if(instance!=null)instance.physicalKeys.button(button,down);}
 public static void physicalInput(){if(instance!=null&&controlling()){instance.physicalAt=System.currentTimeMillis();instance.physicalTakeover=true;}}
 public static boolean physicalTakeoverPending(){return instance!=null&&instance.physicalTakeover;}
 public static boolean ownsCurrentScreen(){return instance!=null&&instance.ownsScreen(MinecraftClient.getInstance());}
 private boolean ownsScreen(MinecraftClient c){return c.currentScreen!=null&&(c.currentScreen==ownedScreen||requestedInventoryScreen(c)||survival.acceptsScreen(c.currentScreen)||tasks.active()&&tasks.acceptsScreen(c.currentScreen));}
 private boolean requestedInventoryScreen(MinecraftClient c){
  if(inventoryRequest==null||c.player==null||c.player.getVehicle()==null||!inventoryRequest.target().equals("entity:"+c.player.getVehicle().getId()))return false;
  return dev.momo.task.InventoryReceipts.CURRENT.confirmedWindow(inventoryRequest,c.world,c.currentScreen,c.player.currentScreenHandler.syncId,System.nanoTime()/1000000);
 }
 private boolean deathScreen(MinecraftClient c){return c.player!=null&&!c.player.isAlive()&&c.currentScreen instanceof net.minecraft.client.gui.screen.DeathScreen;}
 private boolean suspended(MinecraftClient c){return !c.isWindowFocused()||(c.currentScreen!=null&&!ownsScreen(c)&&!deathScreen(c));}
 private void rememberScreen(MinecraftClient c){if(c.currentScreen==null)ownedScreen=null;else if(ownsScreen(c)){ownedScreen=c.currentScreen;inventoryRequest=null;}if(inventoryRequest!=null&&System.nanoTime()/1000000>inventoryRequest.deadline())inventoryRequest=null;}
 private void takeover(MinecraftClient c){physicalTakeover=false;tasks.stop("manual_takeover");tasks.notice("manual_takeover");release(c,true);ownedScreen=null;pauseBarrier.pause(physicalAt);tasks.pause();restorePhysicalKeys(c);}
 private void restorePhysicalKeys(MinecraftClient c){
  for(var binding:c.options.allKeys){
   var key=net.minecraft.client.util.InputUtil.fromTranslationKey(binding.getBoundKeyTranslationKey());
   var kind=switch(key.getCategory()){
    case KEYSYM -> dev.momo.task.PhysicalInputState.Kind.KEY;
    case SCANCODE -> dev.momo.task.PhysicalInputState.Kind.SCAN;
    case MOUSE -> dev.momo.task.PhysicalInputState.Kind.MOUSE;
   };
   binding.setPressed(c.isWindowFocused()&&physicalKeys.pressed(kind,key.getCode()));
  }
 }
 private void retireScene(MinecraftClient c){release(c);tasks.notice("scene_changed");taskWorldInstance=null;taskWorld=taskAccount=null;sceneObservationRequired=true;}
 private static CompanionClient instance;
 private boolean mining,using,attacking,drivingInput;
 private int useTicks;
 public static boolean suppressVanillaBreaking(){return instance!=null&&((instance.controlLease.primitive()&&instance.mining&&!instance.drivingInput)||instance.tasks.controlsMining());}
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
   net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents.CHAT.register((message,signed,sender,params,received)->{
    var c=MinecraftClient.getInstance();
    dev.momo.task.GameChat.CURRENT.receive(c.world,"player",message.getString(),sender==null?"":sender.getName(),sender!=null&&c.player!=null&&sender.getId().equals(c.player.getUuid()),received.toEpochMilli());
   });
   net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents.GAME.register((message,overlay)->{
    var c=MinecraftClient.getInstance();dev.momo.task.GameChat.CURRENT.receive(c.world,overlay?"overlay":"system",message.getString(),"",false,System.currentTimeMillis());
   });
   ClientLifecycleEvents.CLIENT_STOPPING.register(client -> { release(client); server.stop(0); executor.shutdownNow(); try { java.nio.file.Files.deleteIfExists(rendezvous); } catch (Exception ignored) {} });
  } catch (Exception error) { if (server != null) server.stop(0); if (executor != null) executor.shutdownNow(); }
 }
 private void release(MinecraftClient client) {
  release(client,false);
 }
 private void release(MinecraftClient client,boolean preserveScreen) {
  boolean owned=ownsScreen(client);inventoryRequest=null;
  survival.stop(preserveScreen);tasks.stop("control_released");controlLease.revoke();focusResumeDeadline=0;
  releaseLegacy(client);
  if(client.currentScreen!=null&&dev.momo.task.ControlAdmission.closeOnRelease(preserveScreen,owned,tasks.stopConfirmed(),client.player!=null&&client.player.currentScreenHandler.getCursorStack().isEmpty()))client.player.closeHandledScreen();
  if(!preserveScreen&&tasks.stopConfirmed())ownedScreen=null;
 }
 private void releaseLegacy(MinecraftClient client){
  if(mining && client.interactionManager!=null)client.interactionManager.cancelBlockBreaking();
  if(using && client.interactionManager!=null && client.player!=null && client.player.isUsingItem())client.interactionManager.stopUsingItem(client.player);
  controlLease.endPrimitive();mining = using = attacking = false;
  boundWorld = null; boundAccount = null;
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
    ready.addProperty("focused",client.isWindowFocused());ready.addProperty("world",scope);ready.addProperty("dimension",client.world.getRegistryKey().getValue().toString());ready.addProperty("worldName",client.getServer()!=null?client.getServer().getSaveProperties().getLevelName():serverName(client));ready.addProperty("account",client.player.getUuidAsString());ready.addProperty("playerName",client.player.getName().getString());
   }
   return ready; }
  long version = command.get("epoch").getAsLong();
  if (version < epoch) throw new IllegalArgumentException("Revoked");
  JsonElement retiredTasks=null;
  if (version > epoch) {
   release(client);
   retiredTasks=gson.toJsonTree(tasks.recentSnapshots());
   tasks.resetSession();pauseBarrier.reset();taskWorld=null;taskAccount=null;taskWorldInstance=null;sceneObservationRequired=false;epoch=version;
  }
  JsonObject result = new JsonObject(); result.addProperty("epoch", epoch);
  if(retiredTasks!=null)result.add("retiredTasks",retiredTasks);
  if ("stop".equals(type)) { release(client); result.addProperty("stopped", tasks.stopConfirmed()); result.addProperty("heldControls", tasks.stopConfirmed()?0:-1); return result; }
  if (client.player == null || client.world == null) throw new IllegalStateException("Join an authorized world first");
  String world = worldScope(client);
  String account = client.player.getUuidAsString();
  if (!world.equals(command.get("world").getAsString()) || !account.equals(command.get("account").getAsString())) { release(client); throw new IllegalArgumentException("Identity mismatch"); }
  result.addProperty("world", world);result.addProperty("dimension",client.world.getRegistryKey().getValue().toString()); result.addProperty("account", account);
  if(physicalTakeover)takeover(client);
  if(taskWorldInstance!=null&&taskWorldInstance!=client.world)retireScene(client);
  rememberScreen(client);
  pauseBarrier.observeSuspension(suspended(client));
  result.addProperty("controlRevision",pauseBarrier.revision());
  String admission=dev.momo.task.ControlAdmission.reject(type,client.isWindowFocused(),pauseBarrier.isPaused(),physicalTakeover,sceneObservationRequired,client.currentScreen!=null,ownsScreen(client),!client.player.isAlive(),command.has("skill")?command.get("skill").getAsString():"");
  if(!admission.isEmpty()){result.addProperty("accepted",false);result.addProperty("error",admission);return result;}
  String conflict=dev.momo.task.ControlAdmission.bodyConflict(type,tasks.active());
  if(!conflict.isEmpty()){result.addProperty("accepted",false);result.addProperty("error",conflict);return result;}
  switch (type) {
   case "capabilities" -> {
    result.addProperty("protocol",1);result.addProperty("taskProtocol",1);result.addProperty("craftStationPreparation",true);
    result.addProperty("craftStationPlacement",true);
    result.addProperty("decisionProtocol",1);
    result.addProperty("navigation",BaritoneNavigator.available());result.addProperty("navigationBackend","baritone-1.11.3");
    result.add("skills",gson.toJsonTree(GameSkills.NAMES));result.add("skillDefinitions",dev.momo.task.SkillArguments.contract());
   }
   case "recipes" -> {
    String query=command.get("query").getAsString();if(query.length()>64||query.chars().anyMatch(c->c<32))throw new IllegalArgumentException("Invalid query");
    result.addProperty("screenHandler",GameObservation.screenId(client.player.currentScreenHandler));
    result.add("recipes",GameObservation.recipes(client,query,16));
   }
   case "submit" -> {
    String skill=command.get("skill").getAsString();
    if(client.currentScreen!=null&&!(client.currentScreen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen<?>)&&!ownsScreen(client)&&!skill.equals("respawn")){result.addProperty("accepted",false);result.addProperty("error","MENU_OPEN");return result;}
    if(controlLease.primitive()){result.addProperty("accepted",false);result.addProperty("error","BODY_BUSY");return result;}
    String id=command.get("taskId").getAsString();
    JsonObject args=command.has("args")?command.getAsJsonObject("args"):new JsonObject();
    if(skill.equals("navigate")&&!command.has("args"))for(String key:new String[]{"x","y","z"})args.add(key,command.get(key));
    boolean accepted;
    try{var work=GameSkills.create(skill,args);accepted=tasks.submit(id,skill,args.toString(),client.world.getRegistryKey().getValue().toString(),work,System.nanoTime()/1000000,command.get("leaseMs").getAsLong());}
    catch(IllegalArgumentException|IllegalStateException error){result.addProperty("accepted",false);result.addProperty("error","TASK_REJECTED");return result;}
    taskWorld=world;taskAccount=account;taskWorldInstance=client.world;controlLease.arm(System.nanoTime()/1000000,command.get("leaseMs").getAsLong());
    result.addProperty("accepted",accepted);result.add("task",gson.toJsonTree(tasks.snapshot(id)));
   }
   case "task" -> {
    if(command.has("taskId")){try{result.add("task",gson.toJsonTree(tasks.snapshot(command.get("taskId").getAsString())));}catch(IllegalArgumentException error){result.addProperty("error","TASK_NOT_FOUND");}}
    else result.add("tasks",gson.toJsonTree(tasks.snapshots()));
   }
   case "events" -> {
    var events=gson.toJsonTree(tasks.events(command.get("after").getAsLong())).getAsJsonObject();
    events.add("blockFacts",gson.toJsonTree(dev.momo.task.BlockReceipts.CURRENT.facts(client.world,client.player.getUuidAsString())));
    events.add("chat",gson.toJsonTree(dev.momo.task.GameChat.CURRENT.notification(client.world)));result.add("events",events);
   }
   case "heartbeat" -> {long now=System.nanoTime()/1000000,lease=command.get("leaseMs").getAsLong();tasks.heartbeat(now,lease);controlLease.renew(now,lease);result.addProperty("active",tasks.active());result.addProperty("controlPaused",pauseBarrier.isPaused());result.addProperty("suspended",suspended(client));}
   case "pause" -> {inventoryRequest=null;survival.stop();releaseLegacy(client);focusResumeDeadline=0;pauseBarrier.pause(System.currentTimeMillis());tasks.pause();result.addProperty("paused",true);}
   case "resumeTask" -> {
    if(sceneObservationRequired){result.addProperty("accepted",false);result.addProperty("error","SCENE_OBSERVATION_REQUIRED");return result;}
    long issuedAt=command.has("issuedAt")?command.get("issuedAt").getAsLong():0;
    if(!pauseBarrier.resume(issuedAt)){result.addProperty("accepted",false);result.addProperty("error","NEW_PLAYER_INPUT_REQUIRED");return result;}
    org.lwjgl.glfw.GLFW.glfwFocusWindow(client.getWindow().getHandle());focusResumeDeadline=System.nanoTime()/1000000+1500;
    taskWorld=world;taskAccount=account;taskWorldInstance=client.world;controlLease.arm(System.nanoTime()/1000000,10000);
    if(client.currentScreen==null)tasks.resume();result.addProperty("paused",false);
   }
   case "cancel" -> {
    tasks.cancel(command.get("taskId").getAsString(),"requested");
    result.add("task",gson.toJsonTree(tasks.snapshot(command.get("taskId").getAsString())));
    if(!tasks.active()){survival.stop();releaseLegacy(client);}
   }
   case "observe" -> {
    sceneObservationRequired=false;
    taskWorld=world;taskAccount=account;taskWorldInstance=client.world;
    boolean pixels=!command.has("frame")||command.get("frame").getAsBoolean();
    if(pixels)capture.accept(net.minecraft.client.util.ScreenshotRecorder.takeScreenshot(client.getFramebuffer()));
    result.addProperty("pixelsCaptured",pixels);
    GameObservation.append(client,result);
    result.add("survival",new Gson().toJsonTree(survival.progress()));result.addProperty("gameTick",client.world.getTime());
    result.addProperty("clientFps",client.getCurrentFps());
    result.addProperty("observedAt", System.currentTimeMillis());
    result.addProperty("playerName",client.player.getName().getString());
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
    var nearby=client.world.getEntitiesByClass(net.minecraft.entity.ItemEntity.class,client.player.getBoundingBox().expand(6),item->client.player.canSee(item)&&!item.getStack().isEmpty() && item.squaredDistanceTo(client.player)<=36);
    nearby.sort(java.util.Comparator.comparingDouble(item->item.squaredDistanceTo(client.player)));
    for(var item:nearby.subList(0,Math.min(8,nearby.size()))) {
     JsonObject drop=new JsonObject();drop.addProperty("item",net.minecraft.registry.Registries.ITEM.getId(item.getStack().getItem()).toString());drop.addProperty("count",item.getStack().getCount());
     drop.addProperty("x",Math.round(item.getX()*100)/100.0);drop.addProperty("y",Math.round(item.getY()*100)/100.0);drop.addProperty("z",Math.round(item.getZ()*100)/100.0);drop.addProperty("visible",true);drops.add(drop);
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
    var selected=new java.util.LinkedHashSet<net.minecraft.util.math.BlockPos>();
    candidates.stream().filter(pos->{var state=client.world.getBlockState(pos);return !state.isIn(net.minecraft.registry.tag.BlockTags.LEAVES)&&!state.isIn(net.minecraft.registry.tag.BlockTags.LOGS);}).sorted(java.util.Comparator.comparingDouble(pos->eye.squaredDistanceTo(pos.toCenterPos()))).limit(2).forEach(selected::add);
    for(var pos:candidates){if(selected.size()>=8)break;selected.add(pos);}
    for(var pos:selected) {
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
   case "play" -> {play(client, command, world, account);if(client.currentScreen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen<?>)ownedScreen=client.currentScreen;else if(client.currentScreen==null)ownedScreen=null;}
   case "chat" -> {
    String text = command.get("text").getAsString();
    if (text.isBlank() || text.length() > 256 || isCommandText(text) || text.chars().anyMatch(c -> c < 32)) throw new IllegalArgumentException("Invalid chat");
    client.player.networkHandler.sendChatMessage(text);
   }
   case "follow" -> {
    if(controlLease.primitive())throw new IllegalStateException("Another action owns the body");
    String name=command.get("player").getAsString();
    if(!name.matches("[A-Za-z0-9_]{1,16}"))throw new IllegalArgumentException("Invalid player");
    var player=client.world.getPlayers().stream().filter(p->p!=client.player&&p.getName().getString().equals(name)&&client.player.canSee(p)).findFirst().orElseThrow(()->new IllegalArgumentException("Player is not visible"));
    var args=new JsonObject();args.addProperty("entityId",player.getId());args.addProperty("ticks",dev.momo.task.SkillArguments.legacyFollowTicks(command.has("durationMs")?command.get("durationMs").getAsInt():500));String id="follow-"+java.util.UUID.randomUUID();
    tasks.submit(id,"follow",args.toString(),client.world.getRegistryKey().getValue().toString(),GameSkills.create("follow",args),System.nanoTime()/1000000,10000);
    taskWorld=world;taskAccount=account;taskWorldInstance=client.world;
    result.addProperty("accepted",true);result.add("task",gson.toJsonTree(tasks.snapshot(id)));
   }
   default -> throw new IllegalArgumentException("Unsupported command");
  }
  pauseBarrier.observeSuspension(suspended(client));
  result.addProperty("controlRevision",pauseBarrier.revision());
  return result;
 }
 private void play(MinecraftClient c,JsonObject cmd,String world,String account) {
  if(tasks.active())throw new IllegalStateException("Navigation owns the body");
  String key=cmd.get("control").getAsString();
  int duration=cmd.get("durationMs").getAsInt();
  if(duration<1 || duration>10000 || c.interactionManager==null) throw new IllegalArgumentException("Invalid input");
  inventoryRequest=null;survival.settle(true);releaseLegacy(c);
  if(!controlLease.armed()||controlLease.leaseExpired(System.nanoTime()/1000000))throw new IllegalStateException("Control activity expired");
  var p=c.player;
  if(key.equals("respawn") && !p.isAlive()) {p.requestRespawn();return;}
  if(key.equals("screenClick") || key.equals("screenScroll") || key.equals("screenText") || key.equals("screenKey")) {
   if(key.equals("screenKey")&&cmd.get("key").getAsString().equals("escape")&&c.currentScreen==null){c.openGameMenu(false);return;}
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
      case "escape" -> 256;case "enter" -> 257; case "backspace" -> 259;case "tab" -> 258;
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
   case "inventory" -> {
    if(c.interactionManager.hasRidingInventory()&&p.getVehicle()!=null){
     inventoryRequest=dev.momo.task.InventoryReceipts.CURRENT.requestWindow(c.world,"entity:"+p.getVehicle().getId(),System.nanoTime()/1000000);p.openRidingInventory();
    }else c.setScreen(new net.minecraft.client.gui.screen.ingame.InventoryScreen(p));
    return;
   }
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
  controlLease.beginPrimitive(System.nanoTime()/1000000,duration);boundWorld=world;boundAccount=account;
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
 }
 private SurvivalPolicy.Mode chooseReflex(boolean combatOwned,boolean mealOwned){
  var desired=survival.choose(combatOwned,mealOwned);
  if(!survival.replanReason().isEmpty()){tasks.interrupt(survival.replanReason());survival.settle();return SurvivalPolicy.Mode.NONE;}
  return desired;
 }
 private void tick(MinecraftClient client) {
  dev.momo.task.GameChat.CURRENT.scene(client.world);
  dev.momo.task.PickupLedger.CURRENT.changeWorld(client.world);
  dev.momo.task.BlockReceipts.CURRENT.changeWorld(client.world);
  dev.momo.task.ShieldBlocks.CURRENT.changeWorld(client.world);
  dev.momo.task.InventoryReceipts.CURRENT.changeWorld(client.world);
  if(!client.isWindowFocused())physicalKeys.focusLost();
  pauseBarrier.observeSuspension(suspended(client));
  if(physicalTakeover){takeover(client);return;}
  if(taskWorldInstance!=null&&client.world!=taskWorldInstance){retireScene(client);return;}
  rememberScreen(client);
  long localNow=System.nanoTime()/1000000;
  if(tasks.releasePending()){survival.stop();tasks.stop("stop_unconfirmed");if(pauseBarrier.isPaused()&&!controlLease.armed())restorePhysicalKeys(client);return;}
  // GLFW focus is delivered on a later event pump. Resume only after real focus,
  // otherwise vanilla immediately reopens the unfocused pause menu.
  if(focusResumeDeadline!=0){if(localNow>=focusResumeDeadline)focusResumeDeadline=0;else if(client.isWindowFocused()){focusResumeDeadline=0;if(client.currentScreen instanceof net.minecraft.client.gui.screen.GameMenuScreen)client.setScreen(null);}}
  if(controlLease.idleGuard()&&!tasks.active()){
   if(controlLease.leaseExpired(localNow)||client.player==null||client.world!=taskWorldInstance||!client.player.isAlive()||!client.player.getUuidAsString().equals(taskAccount)){tasks.notice("scene_or_life_changed");release(client);return;}
   if(client.currentScreen!=null&&ownsScreen(client)&&!survival.acceptsScreen(client.currentScreen)&&!pauseBarrier.isPaused()){
    var danger=chooseReflex(false,false);
    if(survival.interruptOwnedScreen(danger,true)){client.player.closeHandledScreen();survival.drive(danger);return;}
   }
   if(survival.canDrive(pauseBarrier.isPaused(),client.isWindowFocused(),client.currentScreen)){var reflex=chooseReflex(false,false);if(reflex!=SurvivalPolicy.Mode.NONE){survival.drive(reflex);return;}}
   survival.settle();
   // Idle survival remains bounded by the renewable body lease.
   return;
  }
  if(tasks.active()){
   String currentWorld=client.world==null?"":worldScope(client);
   if(client.player==null||(!client.player.isAlive()&&!tasks.snapshots().stream().anyMatch(t->t.skill().equals("respawn")&&(t.state().equals("running")||t.state().equals("queued"))))||(taskWorldInstance!=client.world||!taskWorld.equals(currentWorld))||!taskAccount.equals(client.player.getUuidAsString())){tasks.stop("identity_or_life_changed");release(client);return;}
   if(suspended(client)){survival.stop();tasks.pause();tasks.tick(System.nanoTime()/1000000);return;}
   if(!pauseBarrier.isPaused()&&survival.acceptsScreen(client.currentScreen)){
    var reflex=chooseReflex(tasks.handlesCombat(),tasks.handlesEating());
    tasks.pause();tasks.tick(localNow);
    if(tasks.active())survival.drive(reflex);else survival.settle();
    return;
   }
   if(!pauseBarrier.isPaused()&&client.currentScreen!=null&&ownsScreen(client)){
    var reflex=chooseReflex(tasks.handlesCombat(),tasks.handlesEating());
    if(survival.interruptOwnedScreen(reflex,tasks.acceptsScreen(client.currentScreen))){
     tasks.stop("danger_interrupted_station");
     if(!tasks.stopConfirmed()){survival.stop();return;}
     client.player.closeHandledScreen();survival.drive(reflex);return;
    }
   }
   if(!pauseBarrier.isPaused()&&client.currentScreen==null){
    var reflex=chooseReflex(tasks.handlesCombat(),tasks.handlesEating());
    if(reflex!=SurvivalPolicy.Mode.NONE){tasks.pause();tasks.tick(System.nanoTime()/1000000);if(tasks.active())survival.drive(reflex);else survival.settle();return;}
   }
   survival.settle();
   if(!pauseBarrier.isPaused())tasks.resume();
   tasks.tick(System.nanoTime()/1000000);
   rememberScreen(client);
   return;
  }
  if(controlLease.primitive()){
   if(controlLease.leaseExpired(localNow)||client.player==null||!client.player.isAlive()||client.world==null||
      !client.player.getUuidAsString().equals(boundAccount)||!worldScope(client).equals(boundWorld)) {release(client);return;}
   if(pauseBarrier.isPaused()||!client.isWindowFocused()||client.currentScreen!=null){releaseLegacy(client);return;}
   if(controlLease.primitiveExpired(localNow)){releaseLegacy(client);return;}
   var danger=chooseReflex(attacking,using&&client.player.isUsingItem());
   if(danger==SurvivalPolicy.Mode.ESCAPE){releaseLegacy(client);survival.drive(danger);return;}
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
