/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright (C) 2015-2016 Cirilo Bernardo <cirilo.bernardo@gmail.com>
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * Copyright (C) 2022 CERN
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

#define GLM_FORCE_RADIANS

#include <atomic>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>
#include <optional>
#include <set>
#include <utility>

#include <wx/datetime.h>
#include <wx/dir.h>
#include <wx/ffile.h>
#include <wx/filename.h>
#include <wx/log.h>
#include <wx/stdpaths.h>
#include <wx/time.h>
#include <wx/utils.h>

#include "3d_cache.h"
#include "3d_info.h"
#include "3d_plugin_manager.h"
#include "model_substitution_helpers.h"
#include "sg/scenegraph.h"
#include "plugins/3dapi/ifsg_api.h"

#include <advanced_config.h>
#include <collab/collab_auth.h>
#include <collab/collab_rest.h>
#include <collab/collab_session.h>
#include <common.h>     // For ExpandEnvVarSubstitutions
#include <filename_resolver.h>
#include <mmh3_hash.h>
#include <paths.h>
#include <pgm_base.h>
#include <project.h>
#include <settings/common_settings.h>
#include <settings/settings_manager.h>
#include <wx_filename.h>


#define MASK_3D_CACHE "3D_CACHE"

static std::mutex mutex3D_cache;


static bool checkTag( const char* aTag, void* aPluginMgrPtr )
{
    if( nullptr == aTag || nullptr == aPluginMgrPtr )
        return false;

    S3D_PLUGIN_MANAGER *pp = (S3D_PLUGIN_MANAGER*) aPluginMgrPtr;

    return pp->CheckTag( aTag );
}


class S3D_CACHE_ENTRY
{
public:
    S3D_CACHE_ENTRY();
    ~S3D_CACHE_ENTRY();

    void SetHash( const HASH_128& aHash );
    const wxString GetCacheBaseName();

    wxDateTime    modTime;      // file modification time
    HASH_128      m_hash;
    std::string   pluginInfo;   // PluginName:Version string
    SCENEGRAPH*   sceneData;
    S3DMODEL*     renderData;

private:
    // prohibit assignment and default copy constructor
    S3D_CACHE_ENTRY( const S3D_CACHE_ENTRY& source ) = delete;
    S3D_CACHE_ENTRY& operator=( const S3D_CACHE_ENTRY& source ) = delete;

    wxString m_CacheBaseName;  // base name of cache file
};


S3D_CACHE_ENTRY::S3D_CACHE_ENTRY()
{
    sceneData = nullptr;
    renderData = nullptr;
    m_hash.Clear();
}


S3D_CACHE_ENTRY::~S3D_CACHE_ENTRY()
{
    delete sceneData;

    if( nullptr != renderData )
        S3D::Destroy3DModel( &renderData );
}


void S3D_CACHE_ENTRY::SetHash( const HASH_128& aHash )
{
    m_hash = aHash;
}


const wxString S3D_CACHE_ENTRY::GetCacheBaseName()
{
    if( m_CacheBaseName.empty() )
        m_CacheBaseName = m_hash.ToString();

    return m_CacheBaseName;
}


S3D_CACHE::S3D_CACHE()
{
    m_FNResolver = new FILENAME_RESOLVER;
    m_project = nullptr;
    m_Plugins = new S3D_PLUGIN_MANAGER;
}


S3D_CACHE::~S3D_CACHE()
{
    FlushCache();

    delete m_FNResolver;
    delete m_Plugins;
}


/// True when the file starts like a STEP file ("ISO-10303-21;").
static bool isStepFile( const wxString& aPath )
{
    wxLogNull noLog;
    wxFFile   file( aPath, wxS( "rb" ) );
    char      head[256] = {};

    if( !file.IsOpened() )
        return false;

    const size_t got = file.Read( head, sizeof( head ) );

    return std::string( head, got ).find( "ISO-10303-21" ) != std::string::npos;
}


/**
 * A model of KiCad's standard 3D library ("<Library>.3dshapes/<Name>.<ext>") that is not on this
 * computer, fetched from the collaboration server into the library folder on this computer
 * and returned as that file's path; empty when there is nothing to show.
 *
 * Junction ships without the 3D library, so a board drawn where the library was installed
 * would otherwise show bare pads.  Nothing is asked of the network when nobody is signed in,
 * each model is asked for once per run, and the first request the server does not answer at
 * all ends the asking for this run, so a dead connection costs one short timeout, not one per
 * part.  The board is never changed: only where the file is read from.
 */
static wxString fetchLibraryModel( const wxString& aModelFile )
{
    wxString norm = aModelFile;
    norm.Replace( wxS( "\\" ), wxS( "/" ) );

    const size_t libEnd = norm.rfind( wxS( ".3dshapes/" ) );

    if( libEnd == wxString::npos )
        return wxEmptyString;

    const size_t libStart = norm.rfind( wxS( '/' ), libEnd );
    wxString     library = norm.Mid( libStart == wxString::npos ? 0 : libStart + 1,
                                     libEnd - ( libStart == wxString::npos ? 0 : libStart + 1 ) );
    wxFileName   item( norm.Mid( libEnd + 10 ) );
    wxString     ext = item.GetExt().Lower();
    wxString     name = item.GetName();

    // A project's own "<x>.3dshapes" folder is not the standard library: its files travel with
    // the project, and asking the server for them would only find a namesake.
    // Only KiCad's own library is on the server: a third-party folder (${KICAD9_3RD_PARTY},
    // an absolute path on somebody's computer) would only cost a request to be told so.
    const wxString head = aModelFile.BeforeFirst( '/' ).Upper();
    const bool     standard = head.StartsWith( wxS( "${KICAD" ) ) ? head.EndsWith( wxS( "_3DMODEL_DIR}" ) )
                                                                  : ( head == wxS( "${KISYS3DMOD}" )
                                                                      || head == wxS( "$(KISYS3DMOD)" ) );

    if( !standard || library.IsEmpty() || name.IsEmpty()
        || item.GetDirCount() > 0
        || ( ext != wxS( "wrl" ) && ext != wxS( "step" ) && ext != wxS( "stp" ) && ext != wxS( "wrz" ) ) )
    {
        return wxEmptyString;
    }

    static std::mutex         s_mutex;
    static std::set<wxString> s_misses;
    // No answer from the server: fetching pauses until this time (ms), then is tried again.
    static wxLongLong         s_offlineUntil = 0;
    static bool               s_tokenRead = false;
    static wxString           s_server;
    static wxString           s_token;

    // A fetched model becomes part of the library on this computer: it is kept in the 3D
    // model folder beside the downloaded symbols and footprints ("3dmodels/<Library>.3dshapes"),
    // which nothing clears, so each model is downloaded once and is there for every project
    // from then on.  (Models fetched by an earlier version sit in the cache folder; they are
    // moved over the first time they are asked for.)
    wxFileName cached( PATHS::GetManagedLibrariesPath(), name + wxS( ".step" ) );
    cached.AppendDir( wxS( "3dmodels" ) );
    cached.AppendDir( library + wxS( ".3dshapes" ) );

    wxFileName before( PATHS::GetUserCachePath(), name + wxS( ".step" ) );
    before.AppendDir( wxS( "3d-models" ) );
    before.AppendDir( library + wxS( ".3dshapes" ) );

    const wxString key = library + wxS( "/" ) + name;
    wxString       server;
    wxString       token;

    // Only the bookkeeping is done under the lock: the download itself is not, so several
    // models can be fetched at once (S3D_CACHE::FetchMissingLibraryModels).
    {
        std::lock_guard<std::mutex> lock( s_mutex );

        if( !cached.FileExists() && before.FileExists() )
        {
            wxLogNull noLog;

            if( wxFileName::Mkdir( cached.GetPath(), wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
                wxRenameFile( before.GetFullPath(), cached.GetFullPath(), false );
        }

        if( cached.FileExists() )
        {
            if( isStepFile( cached.GetFullPath() ) )
                return cached.GetFullPath();

            // Not a model (a download cut short, an error page): fetch it again.
            wxLogNull noLog;
            wxRemoveFile( cached.GetFullPath() );
        }

        if( wxGetLocalTimeMillis() < s_offlineUntil || s_misses.count( key ) )
            return wxEmptyString;

        if( !s_tokenRead )
        {
            s_tokenRead = true;
            s_server = COLLAB_SESSION::ServerUrl();
            s_token = COLLAB_AUTH::StoredToken( s_server );
        }

        if( s_token.IsEmpty() )
            return wxEmptyString;

        // Deep copies: a wxString's buffer must not be shared between threads.
        server = wxString( s_server.wc_str() );
        token = wxString( s_token.wc_str() );
    }

    auto miss = [&]( bool aOffline )
    {
        std::lock_guard<std::mutex> lock( s_mutex );

        if( aOffline )
            s_offlineUntil = wxGetLocalTimeMillis() + 60000;
        else
            s_misses.insert( key );

        return wxString();
    };

    bool                       noAnswer = false;
    std::optional<std::string> bytes;

    // A connection that fails is tried again by itself before the model is given up for now;
    // the next time the viewer needs it (a minute or more later) it is asked for again.
    for( int attempt = 0; attempt < 3; attempt++ )
    {
        noAnswer = false;
        bytes = COLLAB_REST::DownloadLibraryModel( server, token, library, name, &noAnswer );

        if( bytes || !noAnswer )
            break;

        wxMilliSleep( attempt == 0 ? 1000 : 3000 );
    }

    if( !bytes )
        return miss( noAnswer );

    // An answer that is not a STEP file (a proxy's page, a compressed body) is never kept.
    if( bytes->substr( 0, 256 ).find( "ISO-10303-21" ) == std::string::npos )
        return miss( false );

    wxLogNull noLog;

    // Written beside its final name and moved into place, so a half-written file is never
    // read; the name is this thread's own, so two fetches of one model cannot collide.
    wxFileName partial( cached );
    partial.SetFullName( cached.GetFullName()
                         + wxString::Format( wxS( ".%zx.part" ), std::hash<std::thread::id>()( std::this_thread::get_id() ) ) );

    if( !wxFileName::Mkdir( cached.GetPath(), wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
        return wxEmptyString;

    {
        wxFFile out( partial.GetFullPath(), wxS( "wb" ) );

        if( !out.IsOpened() || out.Write( bytes->data(), bytes->size() ) != bytes->size() || !out.Close() )
            return miss( false );
    }

    if( !wxRenameFile( partial.GetFullPath(), cached.GetFullPath(), true ) )
    {
        wxRemoveFile( partial.GetFullPath() );
        return miss( false );
    }

    return cached.GetFullPath();
}


void S3D_CACHE::FetchMissingLibraryModels( const std::vector<std::pair<wxString, wxString>>& aModels )
{
    std::vector<wxString> wanted;
    std::set<wxString>    seen;

    for( const auto& [file, basePath] : aModels )
    {
        if( file.empty() || !seen.insert( file ).second )
            continue;

        if( m_FNResolver->ResolvePath( file, basePath, {} ).empty() )
            wanted.push_back( file );
    }

    // One model is fetched when it is loaded; the workers are for a board full of them.
    if( wanted.size() < 2 )
        return;

    std::atomic<size_t> next( 0 );

    auto work = [&]()
    {
        for( size_t i = next++; i < wanted.size(); i = next++ )
            fetchLibraryModel( wanted[i] );
    };

    std::vector<std::thread> workers;

    for( size_t i = 0; i < std::min<size_t>( 8, wanted.size() ); i++ )
        workers.emplace_back( work );

    for( std::thread& worker : workers )
        worker.join();
}


SCENEGRAPH* S3D_CACHE::load( const wxString& aModelFile, const wxString& aBasePath, S3D_CACHE_ENTRY** aCachePtr,
                             std::vector<const EMBEDDED_FILES*> aEmbeddedFilesStack, S3DMODEL** aRenderModel )
{
    if( aCachePtr )
        *aCachePtr = nullptr;

    if( aRenderModel )
        *aRenderModel = nullptr;

    wxString full3Dpath = m_FNResolver->ResolvePath( aModelFile, aBasePath, std::move( aEmbeddedFilesStack ) );

    // In CLI / scripting contexts, transparently substitute a matching
    // STEP model for a missing WRL reference so renders and exports
    // don't silently lose geometry.  The GUI handles this via the
    // DIALOG_MIGRATE_3D_MODELS load-time auto-migration, so we skip the
    // fallback there to avoid masking user-visible "missing" state.
    if( full3Dpath.empty() && !Pgm().IsGUI() && MODEL_SUBSTITUTION::IsWrlExtension( aModelFile ) )
    {
        std::lock_guard<std::mutex> catLock( m_substCatalogMutex );

        if( !m_substCatalogBuilt )
        {
            const wxString projectPath = m_project ? m_project->GetProjectPath() : wxString();
            m_substCatalog.Build( projectPath, m_FNResolver );
            m_substCatalogBuilt = true;
        }

        const wxString subst = m_substCatalog.FindMatchFor( aModelFile );

        if( !subst.IsEmpty() )
        {
            wxLogTrace( MASK_3D_CACHE, wxT( "%s:%s:%d\n * [3D model] substituting '%s' -> '%s'\n" ),
                        __FILE__, __FUNCTION__, __LINE__, aModelFile, subst );
            full3Dpath = subst;
        }
    }

    if( full3Dpath.empty() )
        full3Dpath = fetchLibraryModel( aModelFile );

    if( full3Dpath.empty() )
    {
        // the model cannot be found; we cannot proceed
        wxLogTrace( MASK_3D_CACHE, wxT( "%s:%s:%d\n * [3D model] could not find model '%s'\n" ),
                    __FILE__, __FUNCTION__, __LINE__, aModelFile );
        return nullptr;
    }

    // check cache if file is already loaded
    std::lock_guard<std::mutex> lock( mutex3D_cache );

    auto finishEntry = [&]( S3D_CACHE_ENTRY* ep ) -> SCENEGRAPH*
    {
        if( !ep )
            return nullptr;

        if( aCachePtr )
            *aCachePtr = ep;

        // Lazy renderData conversion under the same lock that owns the entry.
        if( aRenderModel )
        {
            if( !ep->renderData && ep->sceneData )
                ep->renderData = S3D::GetModel( ep->sceneData );

            *aRenderModel = ep->renderData;
        }

        return ep->sceneData;
    };

    std::map< wxString, S3D_CACHE_ENTRY*, rsort_wxString >::iterator mi;
    mi = m_CacheMap.find( full3Dpath );

    if( mi != m_CacheMap.end() )
    {
        wxFileName fname( full3Dpath );

        if( fname.FileExists() )    // Only check if file exists. If not, it will
        {                           // use the same model in cache.
            bool       reload = ADVANCED_CFG::GetCfg().m_Skip3DModelMemoryCache;
            wxDateTime fmdate = fname.GetModificationTime();

            if( fmdate != mi->second->modTime )
            {
                HASH_128 hashSum;
                getHash( full3Dpath, hashSum );
                mi->second->modTime = fmdate;

                if( hashSum != mi->second->m_hash )
                {
                    mi->second->SetHash( hashSum );
                    reload = true;
                }
            }

            if( reload )
            {
                if( nullptr != mi->second->sceneData )
                {
                    S3D::DestroyNode( mi->second->sceneData );
                    mi->second->sceneData = nullptr;
                }

                if( nullptr != mi->second->renderData )
                    S3D::Destroy3DModel( &mi->second->renderData );

                mi->second->sceneData = m_Plugins->Load3DModel( full3Dpath, mi->second->pluginInfo );
            }
        }

        return finishEntry( mi->second );
    }

    // a cache item does not exist; search the Filename->Cachename map
    S3D_CACHE_ENTRY* ep = nullptr;
    checkCache( full3Dpath, &ep );
    return finishEntry( ep );
}


SCENEGRAPH* S3D_CACHE::Load( const wxString& aModelFile, const wxString& aBasePath,
                             std::vector<const EMBEDDED_FILES*> aEmbeddedFilesStack )
{
    return load( aModelFile, aBasePath, nullptr, std::move( aEmbeddedFilesStack ) );
}


SCENEGRAPH* S3D_CACHE::checkCache( const wxString& aFileName, S3D_CACHE_ENTRY** aCachePtr )
{
    if( aCachePtr )
        *aCachePtr = nullptr;

    HASH_128    hashSum;
    S3D_CACHE_ENTRY* ep = new S3D_CACHE_ENTRY;
    m_CacheList.push_back( ep );
    wxFileName fname( aFileName );
    ep->modTime = fname.GetModificationTime();

    if( !getHash( aFileName, hashSum ) || m_CacheDir.empty() )
    {
        // just in case we can't get a hash digest (for example, on access issues)
        // or we do not have a configured cache file directory, we create an
        // entry to prevent further attempts at loading the file

        if( m_CacheMap.emplace( aFileName, ep ).second == false )
        {
            wxLogTrace( MASK_3D_CACHE, wxT( "%s:%s:%d\n * [BUG] duplicate entry in map file; key = '%s'" ),
                        __FILE__, __FUNCTION__, __LINE__, aFileName );

            m_CacheList.pop_back();
            delete ep;
        }
        else
        {
            if( aCachePtr )
                *aCachePtr = ep;
        }

        return nullptr;
    }

    if( m_CacheMap.emplace( aFileName, ep ).second == false )
    {
        wxLogTrace( MASK_3D_CACHE, wxT( "%s:%s:%d\n * [BUG] duplicate entry in map file; key = '%s'" ),
                    __FILE__, __FUNCTION__, __LINE__, aFileName );

        m_CacheList.pop_back();
        delete ep;
        return nullptr;
    }

    if( aCachePtr )
        *aCachePtr = ep;

    ep->SetHash( hashSum );

    wxString bname = ep->GetCacheBaseName();
    wxString cachename = m_CacheDir + bname + wxT( ".3dc" );

    if( !ADVANCED_CFG::GetCfg().m_Skip3DModelFileCache && wxFileName::FileExists( cachename )
        && loadCacheData( ep ) )
    {
        return ep->sceneData;
    }

    ep->sceneData = m_Plugins->Load3DModel( aFileName, ep->pluginInfo );

    if( !ADVANCED_CFG::GetCfg().m_Skip3DModelFileCache && nullptr != ep->sceneData )
        saveCacheData( ep );

    return ep->sceneData;
}


bool S3D_CACHE::getHash( const wxString& aFileName, HASH_128& aHash )
{
    if( aFileName.empty() )
    {
        wxLogTrace( MASK_3D_CACHE, wxT( "%s:%s:%d\n * [BUG] empty filename" ), __FILE__, __FUNCTION__, __LINE__ );

        return false;
    }

#ifdef _WIN32
    FILE* fp = _wfopen( aFileName.wc_str(), L"rb" );
#else
    FILE* fp = fopen( aFileName.ToUTF8(), "rb" );
#endif

    if( nullptr == fp )
        return false;

    MMH3_HASH dblock( 0xA1B2C3D4 );
    std::vector<char> block( 4096 );
    size_t bsize = 0;

    while( ( bsize = fread( block.data(), 1, 4096, fp ) ) > 0 )
        dblock.add( block );

    fclose( fp );
    aHash = dblock.digest();
    return true;
}


bool S3D_CACHE::loadCacheData( S3D_CACHE_ENTRY* aCacheItem )
{
    wxString bname = aCacheItem->GetCacheBaseName();

    if( bname.empty() )
    {
        wxLogTrace( MASK_3D_CACHE, wxT( " * [3D model] cannot load cached model; no file hash available" ) );

        return false;
    }

    if( m_CacheDir.empty() )
    {
        wxLogTrace( MASK_3D_CACHE, wxT( " * [3D model] cannot load cached model; config directory unknown" ) );

        return false;
    }

    wxString fname = m_CacheDir + bname + wxT( ".3dc" );

    if( !wxFileName::FileExists( fname ) )
    {
        wxLogTrace( MASK_3D_CACHE, wxT( " * [3D model] cannot open file '%s'" ), fname.GetData() );
        return false;
    }

    if( nullptr != aCacheItem->sceneData )
        S3D::DestroyNode( (SGNODE*) aCacheItem->sceneData );

    aCacheItem->sceneData = (SCENEGRAPH*)S3D::ReadCache( fname.ToUTF8(), m_Plugins, checkTag );

    if( nullptr == aCacheItem->sceneData )
        return false;

    return true;
}


bool S3D_CACHE::saveCacheData( S3D_CACHE_ENTRY* aCacheItem )
{
    if( nullptr == aCacheItem )
    {
        wxLogTrace( MASK_3D_CACHE, wxT( "%s:%s:%d\n * NULL passed for aCacheItem" ),
                    __FILE__, __FUNCTION__, __LINE__ );

        return false;
    }

    if( nullptr == aCacheItem->sceneData )
    {
        wxLogTrace( MASK_3D_CACHE, wxT( "%s:%s:%d\n * aCacheItem has no valid scene data" ),
                    __FILE__, __FUNCTION__, __LINE__ );

        return false;
    }

    wxString bname = aCacheItem->GetCacheBaseName();

    if( bname.empty() )
    {
        wxLogTrace( MASK_3D_CACHE, wxT( " * [3D model] cannot load cached model; no file hash available" ) );

        return false;
    }

    if( m_CacheDir.empty() )
    {
        wxLogTrace( MASK_3D_CACHE, wxT( " * [3D model] cannot load cached model; config directory unknown" ) );

        return false;
    }

    wxString fname = m_CacheDir + bname + wxT( ".3dc" );

    if( wxFileName::Exists( fname ) )
    {
        if( !wxFileName::FileExists( fname ) )
        {
            wxLogTrace( MASK_3D_CACHE, wxT( " * [3D model] path exists but is not a regular file '%s'" ), fname );

            return false;
        }
    }

    return S3D::WriteCache( fname.ToUTF8(), true, (SGNODE*)aCacheItem->sceneData, aCacheItem->pluginInfo.c_str() );
}


bool S3D_CACHE::Set3DConfigDir( const wxString& aConfigDir )
{
    if( !m_ConfigDir.empty() )
        return false;

    wxFileName cfgdir( ExpandEnvVarSubstitutions( aConfigDir, m_project ), wxEmptyString );

    cfgdir.Normalize( FN_NORMALIZE_FLAGS );

    if( !cfgdir.DirExists() )
    {
        cfgdir.Mkdir( wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL );

        if( !cfgdir.DirExists() )
        {
            wxLogTrace( MASK_3D_CACHE, wxT( "%s:%s:%d\n * failed to create 3D configuration directory '%s'" ),
                        __FILE__, __FUNCTION__, __LINE__, cfgdir.GetPath() );

            return false;
        }
    }

    m_ConfigDir = cfgdir.GetPath();

    // inform the file resolver of the config directory
    if( !m_FNResolver->Set3DConfigDir( m_ConfigDir ) )
    {
        wxLogTrace( MASK_3D_CACHE, wxT( "%s:%s:%d\n * could not set 3D Config Directory on filename resolver\n"
                                        " * config directory: '%s'" ),
                    __FILE__, __FUNCTION__, __LINE__, m_ConfigDir );
    }

    // 3D cache data must go to a user's cache directory;
    // unfortunately wxWidgets doesn't seem to provide
    // functions to retrieve such a directory.
    //
    // 1. OSX: ~/Library/Caches/kicad/3d/
    // 2. Linux: ${XDG_CACHE_HOME}/kicad/3d ~/.cache/kicad/3d/
    // 3. MSWin: AppData\Local\kicad\3d
    wxFileName cacheDir;
    cacheDir.AssignDir( PATHS::GetUserCachePath() );
    cacheDir.AppendDir( wxT( "3d" ) );

    if( !cacheDir.DirExists() )
    {
        cacheDir.Mkdir( wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL );

        if( !cacheDir.DirExists() )
        {
            wxLogTrace( MASK_3D_CACHE, wxT( "%s:%s:%d\n * failed to create 3D cache directory '%s'" ),
                        __FILE__, __FUNCTION__, __LINE__, cacheDir.GetPath() );

            return false;
        }
    }

    m_CacheDir = cacheDir.GetPathWithSep();
    return true;
}


bool S3D_CACHE::SetProject( PROJECT* aProject )
{
    m_project = aProject;

    bool hasChanged = false;

    if( m_FNResolver->SetProject( aProject, &hasChanged ) && hasChanged )
    {
        std::lock_guard<std::mutex> lock( mutex3D_cache );

        m_CacheMap.clear();

        std::list< S3D_CACHE_ENTRY* >::iterator sL = m_CacheList.begin();
        std::list< S3D_CACHE_ENTRY* >::iterator eL = m_CacheList.end();

        while( sL != eL )
        {
            delete *sL;
            ++sL;
        }

        m_CacheList.clear();

        return true;
    }

    return false;
}


void S3D_CACHE::SetProgramBase( PGM_BASE* aBase )
{
    m_FNResolver->SetProgramBase( aBase );
}


FILENAME_RESOLVER* S3D_CACHE::GetResolver() noexcept
{
    return m_FNResolver;
}


std::list< wxString > const* S3D_CACHE::GetFileFilters() const
{
    return m_Plugins->GetFileFilters();
}


void S3D_CACHE::FlushCache( bool closePlugins )
{
    std::lock_guard<std::mutex> lock( mutex3D_cache );

    std::list< S3D_CACHE_ENTRY* >::iterator sCL = m_CacheList.begin();
    std::list< S3D_CACHE_ENTRY* >::iterator eCL = m_CacheList.end();

    while( sCL != eCL )
    {
        delete *sCL;
        ++sCL;
    }

    m_CacheList.clear();
    m_CacheMap.clear();

    if( closePlugins )
        ClosePlugins();
}


void S3D_CACHE::ClosePlugins()
{
    if( m_Plugins )
        m_Plugins->ClosePlugins();
}


S3DMODEL* S3D_CACHE::GetModel( const wxString& aModelFileName, const wxString& aBasePath,
                               std::vector<const EMBEDDED_FILES*> aEmbeddedFilesStack )
{
    S3DMODEL* mp = nullptr;

    if( !load( aModelFileName, aBasePath, nullptr, std::move( aEmbeddedFilesStack ), &mp ) )
        return nullptr;

    return mp;
}

void S3D_CACHE::CleanCacheDir( int aNumDaysOld )
{
    wxDir         dir;
    wxString      fileSpec = wxT( "*.3dc" );
    wxArrayString fileList; // Holds list of ".3dc" files found in cache directory
    size_t        numFilesFound = 0;

    wxFileName thisFile;
    wxDateTime lastAccess, thresholdDate;
    wxDateSpan durationInDays;

    // Calc the threshold date above which we delete cache files
    durationInDays.SetDays( aNumDaysOld );
    thresholdDate = wxDateTime::Now() - durationInDays;

    // If the cache directory can be found and opened, then we'll try and clean it up
    if( dir.Open( m_CacheDir ) )
    {
        thisFile.SetPath( m_CacheDir ); // Set the base path to the cache folder

        // Get a list of all the ".3dc" files in the cache directory
        numFilesFound = dir.GetAllFiles( m_CacheDir, &fileList, fileSpec );

        for( unsigned int i = 0; i < numFilesFound; i++ )
        {
            // Completes path to specific file so we can get its "last access" date
            thisFile.SetFullName( fileList[i] );

            // Only get "last access" time to compare against. Don't need the other 2 timestamps.
            if( thisFile.GetTimes( &lastAccess, nullptr, nullptr ) )
            {
                if( lastAccess.IsEarlierThan( thresholdDate ) )
                {
                    // This file is older than the threshold so delete it
                    wxRemoveFile( thisFile.GetFullPath() );
                }
            }
        }
    }
}
