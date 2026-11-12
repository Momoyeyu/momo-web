package dev.momo;

import com.google.gson.*;
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
 private String target, boundWorld, boundAccount;
 private java.util.List<BoundedPath.Cell> path = java.util.List.of();
 private long nextPlan;
 private boolean playing;
 private Boolean pauseBeforeControl;
 private long backgroundUntil;
 private java.nio.file.Path rendezvous;
 private HttpServer server;
 private ExecutorService executor;
 private final Gson gson = new Gson();
 public void onInitializeClient() {
  String token = System.getProperty("momo.bridge.token", "");
  if (token.length() < 32) token = java.util.UUID.randomUUID().toString()+java.util.UUID.randomUUID();
  final String sessionToken = token;
  try {
   server = HttpServer.create(new InetSocketAddress("127.0.0.1", Integer.getInteger("momo.bridge.port", 0)), 8);
   executor = Executors.newSingleThreadExecutor();
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
     CompletableFuture<JsonObject> result = new CompletableFuture<>();
     MinecraftClient.getInstance().execute(() -> {
      try { if (System.nanoTime() > expires) throw new IllegalStateException("Expired"); result.complete(command(command)); }
      catch (Exception error) { result.completeExceptionally(error); }
     });
     response = gson.toJson(result.get(2500, TimeUnit.MILLISECONDS)).getBytes(StandardCharsets.UTF_8);
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
  if(pauseBeforeControl!=null) client.options.pauseOnLostFocus=pauseBeforeControl;
  pauseBeforeControl=null; backgroundUntil=0;
 }
 private void backgroundControl(MinecraftClient client) {
  if(pauseBeforeControl==null) pauseBeforeControl=client.options.pauseOnLostFocus;
  client.options.pauseOnLostFocus=false;
  // Separate from held-key leases: allow the model time to inspect and plan,
  // but restore the player's preference after a disconnected controller.
  backgroundUntil=System.nanoTime()+TimeUnit.SECONDS.toNanos(60);
 }
 private void release(MinecraftClient client) {
  playing = false;
  path = java.util.List.of(); nextPlan = 0;
  target = null; boundWorld = null; boundAccount = null; deadline = 0;
  client.options.forwardKey.setPressed(false); client.options.backKey.setPressed(false);
  client.options.leftKey.setPressed(false); client.options.rightKey.setPressed(false);
  client.options.jumpKey.setPressed(false); client.options.sneakKey.setPressed(false);
  client.options.sprintKey.setPressed(false); client.options.attackKey.setPressed(false); client.options.useKey.setPressed(false);
 }
 private JsonObject command(JsonObject command) throws Exception {
  MinecraftClient client = MinecraftClient.getInstance();
  String type = command.get("type").getAsString();
  if ("ping".equals(type)) { JsonObject ready = new JsonObject(); ready.addProperty("ready", true); ready.addProperty("protocol", 1);
   if (client.player!=null && client.world!=null) {
    String scope=(client.getCurrentServerEntry()!=null?client.getCurrentServerEntry().address:"local")+"/"+client.world.getRegistryKey().getValue();
    ready.addProperty("world",scope);ready.addProperty("account",client.player.getUuidAsString());ready.addProperty("playerName",client.player.getName().getString());
   }
   return ready; }
  long version = command.get("epoch").getAsLong();
  if (version < epoch) throw new IllegalArgumentException("Revoked");
  if (version > epoch) { release(client); restorePause(client); epoch = version; }
  JsonObject result = new JsonObject(); result.addProperty("epoch", epoch);
  if ("stop".equals(type)) { release(client); restorePause(client); result.addProperty("stopped", true); result.addProperty("heldControls", 0); return result; }
  if (client.player == null || client.world == null) throw new IllegalStateException("Join an authorized world first");
  String world = (client.getCurrentServerEntry()!=null?client.getCurrentServerEntry().address:"local") + "/" + client.world.getRegistryKey().getValue();
  String account = client.player.getUuidAsString();
  if (!world.equals(command.get("world").getAsString()) || !account.equals(command.get("account").getAsString())) { release(client); restorePause(client); throw new IllegalArgumentException("Identity mismatch"); }
  if(pauseBeforeControl!=null) backgroundControl(client);
  result.addProperty("world", world); result.addProperty("account", account);
  switch (type) {
   case "observe" -> {
    if (!client.options.getPerspective().isFirstPerson()) throw new IllegalStateException("First person required");
    try (var raw = net.minecraft.client.util.ScreenshotRecorder.takeScreenshot(client.getFramebuffer())) {
     int width = Math.min(960, raw.getWidth());
     int height = Math.max(1, raw.getHeight() * width / raw.getWidth());
     try (var scaled = new net.minecraft.client.texture.NativeImage(width, height, false)) {
      raw.resizeSubRectTo(0, 0, raw.getWidth(), raw.getHeight(), scaled);
      byte[] png = scaled.getBytes();
      if (png.length > 4_000_000) throw new IllegalStateException("Frame too large");
      result.addProperty("frame", "data:image/png;base64," + java.util.Base64.getEncoder().encodeToString(png));
     }
    }
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
    JsonArray slots=new JsonArray(),emptySlots=new JsonArray();
    for(var slot:client.player.currentScreenHandler.slots){
     if(slot.getStack().isEmpty()){emptySlots.add(slot.id);continue;}
     JsonObject item=new JsonObject(); item.addProperty("id",slot.id);item.addProperty("item",net.minecraft.registry.Registries.ITEM.getId(slot.getStack().getItem()).toString());item.addProperty("count",slot.getStack().getCount()); slots.add(item);
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
    if (text.isBlank() || text.length() > 256 || text.stripLeading().startsWith("/") || text.chars().anyMatch(c -> c < 32)) throw new IllegalArgumentException("Invalid chat");
    client.player.networkHandler.sendChatMessage(text);
   }
   case "follow" -> {
    String player = command.get("player").getAsString(); int duration = command.get("durationMs").getAsInt();
    if (!player.matches("[A-Za-z0-9_]{1,16}") || duration < 1 || duration > 1000) throw new IllegalArgumentException("Invalid follow");
    backgroundControl(client);
    target = player; boundWorld = world; boundAccount = account; deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(duration);
   }
   default -> throw new IllegalArgumentException("Unsupported command");
  }
  return result;
 }
 private void play(MinecraftClient c,JsonObject cmd,String world,String account) {
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
     if(text.length()>256||text.stripLeading().startsWith("/")||text.chars().anyMatch(ch->ch<32))throw new IllegalArgumentException("Invalid game text");
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
   case "hotbar" -> {int slot=cmd.get("slot").getAsInt();if(slot<0||slot>8)throw new IllegalArgumentException("Invalid hotbar slot");p.getInventory().selectedSlot=slot;return;}
   case "inventory" -> {c.setScreen(new net.minecraft.client.gui.screen.ingame.InventoryScreen(p));return;}
   case "drop" -> {p.dropSelectedItem(false);return;}
   default -> {}
  }
  var binding=switch(key){
   case "forward","sprint" -> o.forwardKey;case "back" -> o.backKey;case "left" -> o.leftKey;case "right" -> o.rightKey;
   case "jump" -> o.jumpKey;case "sneak" -> o.sneakKey;case "attack","mine" -> o.attackKey;
   case "use","eat" -> o.useKey;case "swapHands" -> o.swapHandsKey;default -> throw new IllegalArgumentException("Unknown control");
  };
  if(key.equals("attack")||key.equals("mine")||key.equals("use")||key.equals("eat")||key.equals("swapHands"))
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
  playing=true; boundWorld=world; boundAccount=account;deadline=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(duration);
 }
 private void tick(MinecraftClient client) {
  if(pauseBeforeControl!=null && (System.nanoTime()>=backgroundUntil || client.player==null || client.world==null)) {release(client);restorePause(client);}
  if(playing){
   if(System.nanoTime()>=deadline||client.player==null||!client.player.isAlive()||client.world==null||client.currentScreen!=null||
      !client.player.getUuidAsString().equals(boundAccount)||!((client.getCurrentServerEntry()!=null?client.getCurrentServerEntry().address:"local")+"/"+client.world.getRegistryKey().getValue()).equals(boundWorld)) release(client);
   return;
  }
  if (target == null) return;
  if (System.nanoTime() >= deadline || client.player == null || client.world == null || !client.player.isAlive() || client.currentScreen != null) { release(client); return; }
  if (!((client.getCurrentServerEntry()!=null?client.getCurrentServerEntry().address:"local") + "/" + client.world.getRegistryKey().getValue()).equals(boundWorld) || !client.player.getUuidAsString().equals(boundAccount)) { release(client); return; }
  var player = client.world.getPlayers().stream().filter(p -> p.getName().getString().equals(target)).findFirst().orElse(null);
  // Replan at 5 Hz within known terrain; stop rather than jump/dig across hazards.
  if (player == null || !client.player.canSee(player) || client.player.squaredDistanceTo(player) > 256 || !client.player.isOnGround()) { release(client); return; }
  if (client.player.squaredDistanceTo(player) <= 9) { client.options.forwardKey.setPressed(false); return; }
  int y = client.player.getBlockPos().getY();
  java.util.function.Predicate<BoundedPath.Cell> safe = c -> {
   var feet = new net.minecraft.util.math.BlockPos(c.x(), y, c.z());
   if (!client.world.isChunkLoaded(feet)) return false;
   var floor = client.world.getBlockState(feet.down());
   return floor.isFullCube(client.world, feet.down()) && !floor.isOf(net.minecraft.block.Blocks.MAGMA_BLOCK)
    && !floor.isOf(net.minecraft.block.Blocks.CACTUS) && !floor.isOf(net.minecraft.block.Blocks.CAMPFIRE)
    && client.world.getBlockState(feet).isAir() && client.world.getBlockState(feet.up()).isAir()
    && client.world.getFluidState(feet).isEmpty();
  };
  if (System.nanoTime() >= nextPlan || path.isEmpty() || client.player.horizontalCollision) {
   path = BoundedPath.find(new BoundedPath.Cell(client.player.getBlockPos().getX(),client.player.getBlockPos().getZ()),
    new BoundedPath.Cell(player.getBlockPos().getX(),player.getBlockPos().getZ()),safe,512);
   nextPlan = System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(200);
  }
  if (path.isEmpty() || !safe.test(path.get(0))) { release(client); return; }
  var waypoint = path.get(0);
  double dx = waypoint.x()+.5-client.player.getX(), dz = waypoint.z()+.5-client.player.getZ();
  if (dx*dx+dz*dz<.08) { path=path.subList(1,path.size());client.options.forwardKey.setPressed(false);return; }
  client.player.setYaw((float)Math.toDegrees(Math.atan2(-dx,dz)));
  client.options.forwardKey.setPressed(true);
 }
}
