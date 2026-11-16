package dev.momo.fixture;
import com.google.gson.Gson;
import java.nio.file.*;
import java.util.*;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.GameMenuScreen;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.util.WorldSavePath;

/**
 * Drives a real vanilla disconnect/load in one client process. It never calls a
 * companion callback or reads/modifies its task, input, permission or goal state.
 * The entire source set and manifest are absent from the shipping companion.
 */
public final class WorldTransitionFixtures implements ClientModInitializer {
 private enum Phase{WAIT_SOURCE,READY,DISCONNECTED,LOADING,PAUSING,DONE,FAILED}
 private Phase phase=Phase.WAIT_SOURCE;private Path root,source,target;private Object sourceWorld;
 private final List<Map<String,Object>> events=new ArrayList<>();private long started;private int ticks;
 public void onInitializeClient(){
  if(!WorldTransitionGuard.FLAG.equals(System.getProperty("momo.fixture.transition","")))return;
  root=FabricLoader.getInstance().getGameDir().toAbsolutePath().normalize();
  ClientTickEvents.END_CLIENT_TICK.register(this::tick);
 }
 private Path loaded(MinecraftClient c){
  return c.getServer()==null?null:c.getServer().getSavePath(WorldSavePath.ROOT).toAbsolutePath().normalize();
 }
 private void report(String event,Map<String,Object> extra)throws java.io.IOException{
  if(source==null||WorldTransitionGuard.target(root,source,WorldTransitionGuard.FLAG).isEmpty())throw new java.io.IOException("Test save markers changed");
  var row=new LinkedHashMap<String,Object>(extra);row.put("event",event);row.put("nanoTime",System.nanoTime());events.add(Map.copyOf(row));
  Path file=source.resolve(".momo-transition-report.json"),temporary=source.resolve(".momo-transition-report.tmp");
  Files.writeString(temporary,new Gson().toJson(Map.of("phase",phase.name().toLowerCase(Locale.ROOT),"pid",ProcessHandle.current().pid(),"events",List.copyOf(events))));
  Files.move(temporary,file,StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
 }
 private void fail(String reason){
  phase=Phase.FAILED;
  try{report("failed",Map.of("reason",reason));}catch(java.io.IOException ignored){}
  System.getLogger("momo-fixture").log(System.Logger.Level.WARNING,"World transition test stopped: "+reason);
 }
 private void tick(MinecraftClient c){
  if(phase==Phase.DONE||phase==Phase.FAILED)return;
  try{
   if(started!=0&&System.nanoTime()-started>60_000_000_000L){fail("transition_timeout");return;}
   if(phase==Phase.WAIT_SOURCE){
    Path save=loaded(c);if(save==null||c.world==null||c.player==null||!c.player.isAlive())return;
    var destination=WorldTransitionGuard.target(root,save,WorldTransitionGuard.FLAG);if(destination.isEmpty())return;
    if(c.currentScreen!=null&&!(c.currentScreen instanceof GameMenuScreen))return;
    source=save;target=destination.get();sourceWorld=c.world;
    if(c.currentScreen==null)c.openGameMenu(false);
    phase=Phase.READY;report("source_paused",Map.of("save",WorldTransitionGuard.A));return;
   }
   if(phase==Phase.READY){
    if(!source.equals(loaded(c))||c.world!=sourceWorld){fail("source_changed_before_request");return;}
    if(c.currentScreen!=null||++ticks%10!=0)return;
    var destination=WorldTransitionGuard.claim(root,source,WorldTransitionGuard.FLAG);if(destination.isEmpty())return;
    target=destination.get();started=System.nanoTime();phase=Phase.DISCONNECTED;
    report("disconnecting",Map.of("save",WorldTransitionGuard.A));
    // Match the vanilla game-menu path, including its real network close.
    c.world.disconnect();c.disconnect(new TitleScreen());c.setScreen(new TitleScreen());return;
   }
   if(phase==Phase.DISCONNECTED){
    // A separate client tick lets normal companion listeners observe the
    // unloaded world before the next integrated server starts.
    if(c.world!=null||c.getServer()!=null){fail("disconnect_did_not_unload");return;}
    if(WorldTransitionGuard.target(root,source,WorldTransitionGuard.FLAG).filter(target::equals).isEmpty()){fail("target_changed");return;}
    phase=Phase.LOADING;report("loading_target",Map.of("save",WorldTransitionGuard.B));
    c.createIntegratedServerLoader().start(WorldTransitionGuard.B,()->fail("load_cancelled"));return;
   }
   if(phase==Phase.LOADING){
    if(c.world==null||c.player==null||c.getServer()==null)return;
    if(!target.equals(loaded(c))){fail("unexpected_target");return;}
    if(c.currentScreen!=null||!c.player.isAlive())return;
    if(c.world==sourceWorld){fail("world_instance_reused");return;}
    c.openGameMenu(false);phase=Phase.PAUSING;return;
   }
   if(phase==Phase.PAUSING){
    if(!target.equals(loaded(c))||c.world==null||c.player==null){fail("target_changed_before_pause");return;}
    if(!(c.currentScreen instanceof GameMenuScreen)||!c.getServer().isPaused())return;
    phase=Phase.DONE;report("target_paused",Map.of("save",WorldTransitionGuard.B,"worldObjectChanged",c.world!=sourceWorld));
    sourceWorld=null;
   }
  }catch(Exception error){fail(error.getClass().getSimpleName());}
 }
}
