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

/** Dedicated-client bridge. All Minecraft access runs on the game thread. */
public final class CompanionClient implements ClientModInitializer {
 private long epoch = -1, deadline;
 private String target, boundWorld, boundAccount;
 private java.util.List<BoundedPath.Cell> path = java.util.List.of();
 private long nextPlan;
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
   ClientLifecycleEvents.CLIENT_STOPPING.register(client -> { release(client); server.stop(0); executor.shutdownNow(); try { java.nio.file.Files.deleteIfExists(rendezvous); } catch (Exception ignored) {} });
  } catch (Exception error) { if (server != null) server.stop(0); if (executor != null) executor.shutdownNow(); }
 }
 private void release(MinecraftClient client) {
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
  if (version > epoch) { release(client); epoch = version; }
  JsonObject result = new JsonObject(); result.addProperty("epoch", epoch);
  if ("stop".equals(type)) { release(client); result.addProperty("stopped", true); result.addProperty("heldControls", 0); return result; }
  if (client.player == null || client.world == null) throw new IllegalStateException("Join an authorized world first");
  String world = (client.getCurrentServerEntry()!=null?client.getCurrentServerEntry().address:"local") + "/" + client.world.getRegistryKey().getValue();
  String account = client.player.getUuidAsString();
  if (!world.equals(command.get("world").getAsString()) || !account.equals(command.get("account").getAsString())) { release(client); throw new IllegalArgumentException("Identity mismatch"); }
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
    result.addProperty("health", client.player.getHealth());
    JsonArray players = new JsonArray();
    for (var player : client.world.getPlayers()) if (player != client.player && client.player.canSee(player) && client.player.squaredDistanceTo(player) <= 1024) players.add(player.getName().getString());
    result.add("visiblePlayers", players);
   }
   case "chat" -> {
    String text = command.get("text").getAsString();
    if (text.isBlank() || text.length() > 256 || text.stripLeading().startsWith("/") || text.chars().anyMatch(c -> c < 32)) throw new IllegalArgumentException("Invalid chat");
    client.player.networkHandler.sendChatMessage(text);
   }
   case "follow" -> {
    String player = command.get("player").getAsString(); int duration = command.get("durationMs").getAsInt();
    if (!player.matches("[A-Za-z0-9_]{1,16}") || duration < 1 || duration > 1000) throw new IllegalArgumentException("Invalid follow");
    target = player; boundWorld = world; boundAccount = account; deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(duration);
   }
   default -> throw new IllegalArgumentException("Unsupported command");
  }
  return result;
 }
 private void tick(MinecraftClient client) {
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
