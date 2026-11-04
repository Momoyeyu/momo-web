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
 private HttpServer server;
 private ExecutorService executor;
 private final Gson gson = new Gson();
 public void onInitializeClient() {
  String token = System.getProperty("momo.bridge.token", "");
  if (token.length() < 32) return; // No unauthenticated listener.
  try {
   server = HttpServer.create(new InetSocketAddress("127.0.0.1", Integer.getInteger("momo.bridge.port", 17643)), 8);
   executor = Executors.newSingleThreadExecutor();
   server.setExecutor(executor);
   server.createContext("/command", exchange -> {
    byte[] response;
    int code = 200;
    try {
     String auth = exchange.getRequestHeaders().getFirst("Authorization");
     if (!"POST".equals(exchange.getRequestMethod()) || auth == null || !MessageDigest.isEqual(auth.getBytes(StandardCharsets.UTF_8), ("Bearer " + token).getBytes(StandardCharsets.UTF_8))) throw new IllegalArgumentException("Unauthorized");
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
   ClientTickEvents.END_CLIENT_TICK.register(this::tick);
   ClientLifecycleEvents.CLIENT_STOPPING.register(client -> { release(client); server.stop(0); executor.shutdownNow(); });
  } catch (Exception error) { if (server != null) server.stop(0); if (executor != null) executor.shutdownNow(); }
 }
 private void release(MinecraftClient client) {
  target = null; boundWorld = null; boundAccount = null; deadline = 0;
  client.options.forwardKey.setPressed(false); client.options.backKey.setPressed(false);
  client.options.leftKey.setPressed(false); client.options.rightKey.setPressed(false);
  client.options.jumpKey.setPressed(false); client.options.sneakKey.setPressed(false);
  client.options.sprintKey.setPressed(false); client.options.attackKey.setPressed(false); client.options.useKey.setPressed(false);
 }
 private JsonObject command(JsonObject command) throws Exception {
  MinecraftClient client = MinecraftClient.getInstance();
  String type = command.get("type").getAsString();
  long version = command.get("epoch").getAsLong();
  if (version < epoch) throw new IllegalArgumentException("Revoked");
  if (version > epoch) { release(client); epoch = version; }
  JsonObject result = new JsonObject(); result.addProperty("epoch", epoch);
  if ("stop".equals(type)) { release(client); result.addProperty("stopped", true); result.addProperty("heldControls", 0); return result; }
  if (client.player == null || client.world == null || client.getCurrentServerEntry() == null) throw new IllegalStateException("Join an authorized multiplayer world first");
  String world = client.getCurrentServerEntry().address + "/" + client.world.getRegistryKey().getValue();
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
  if (client.getCurrentServerEntry() == null || !(client.getCurrentServerEntry().address + "/" + client.world.getRegistryKey().getValue()).equals(boundWorld) || !client.player.getUuidAsString().equals(boundAccount)) { release(client); return; }
  var player = client.world.getPlayers().stream().filter(p -> p.getName().getString().equals(target)).findFirst().orElse(null);
  // Conservative short straight-line follow only. No digging, jumping, or hidden entity access.
  if (player == null || !client.player.canSee(player) || client.player.squaredDistanceTo(player) > 256 || client.player.horizontalCollision || !client.player.isOnGround()) { release(client); return; }
  double dx = player.getX() - client.player.getX(), dz = player.getZ() - client.player.getZ();
  var ahead = client.player.getBlockPos().add((int)Math.signum(dx), -1, (int)Math.signum(dz));
  if (client.world.getBlockState(ahead).isAir() || !client.world.getFluidState(ahead.up()).isEmpty()) { release(client); return; }
  client.player.setYaw((float)Math.toDegrees(Math.atan2(-dx, dz)));
  client.options.forwardKey.setPressed(client.player.squaredDistanceTo(player) > 9);
 }
}
