/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
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

/*
 * EasyEDA Pro 2.x keeps a local project as one SQLite database (.eprj) instead of the .epro zip.  The database
 * holds the same documents an .epro holds, each stored as "base64" + gzip of the very bytes the zip entry would
 * have, plus the project index spread over a few tables.  This file rebuilds the .epro view of such a database
 * (project.json plus SHEET/, PCB/, SYMBOL/, FOOTPRINT/, POUR/ and BLOB/ entries) so the .epro importers read it
 * unchanged.
 */

#include "easyedapro_import_utils.h"

#include <ki_exception.h>
#include <json_common.h>

#include <cstring>
#include <map>
#include <memory>
#include <mutex>

#include <sqlite3.h>

#include <wx/base64.h>
#include <wx/ffile.h>
#include <wx/filename.h>
#include <wx/mstream.h>
#include <wx/wfstream.h>
#include <wx/zstream.h>
#include <wx/intl.h>


namespace
{

struct SQLITE_DB
{
    sqlite3* db = nullptr;
    ~SQLITE_DB()
    {
        if( db )
            sqlite3_close( db );
    }
};


std::string columnText( sqlite3_stmt* aStmt, int aCol )
{
    const unsigned char* text = sqlite3_column_text( aStmt, aCol );
    int                  len = sqlite3_column_bytes( aStmt, aCol );

    return text ? std::string( reinterpret_cast<const char*>( text ), len ) : std::string();
}


bool hasColumn( sqlite3* aDb, const char* aTable, const char* aColumn )
{
    std::string   sql = std::string( "PRAGMA table_info(\"" ) + aTable + "\")";
    sqlite3_stmt* stmt = nullptr;
    bool          found = false;

    if( sqlite3_prepare_v2( aDb, sql.c_str(), -1, &stmt, nullptr ) != SQLITE_OK )
        return false;

    while( sqlite3_step( stmt ) == SQLITE_ROW )
    {
        if( columnText( stmt, 1 ) == aColumn )
            found = true;
    }

    sqlite3_finalize( stmt );
    return found;
}


/// Run a query and hand each row to aRow; a missing table or column is not an error (older databases lack some).
void forEachRow( sqlite3* aDb, const std::string& aSql, const std::function<void( sqlite3_stmt* )>& aRow )
{
    sqlite3_stmt* stmt = nullptr;

    if( sqlite3_prepare_v2( aDb, aSql.c_str(), -1, &stmt, nullptr ) != SQLITE_OK )
        return;

    while( sqlite3_step( stmt ) == SQLITE_ROW )
        aRow( stmt );

    sqlite3_finalize( stmt );
}


/// A stored document: "base64" + gzip of the text, or the text itself.
std::string decodeDataStr( const std::string& aData )
{
    static const std::string c_prefix = "base64";

    if( aData.compare( 0, c_prefix.size(), c_prefix ) != 0 )
        return aData;

    wxMemoryBuffer packed = wxBase64Decode( aData.c_str() + c_prefix.size(), aData.size() - c_prefix.size(),
                                            wxBase64DecodeMode_Relaxed );

    if( packed.GetDataLen() == 0 )
        return std::string();

    const unsigned char* bytes = static_cast<const unsigned char*>( packed.GetData() );

    if( packed.GetDataLen() < 2 || bytes[0] != 0x1f || bytes[1] != 0x8b )
        return std::string( static_cast<const char*>( packed.GetData() ), packed.GetDataLen() );

    wxMemoryInputStream memIn( packed.GetData(), packed.GetDataLen() );
    wxZlibInputStream   gz( memIn, wxZLIB_GZIP );
    std::string         out;
    char                buf[64 * 1024];

    while( true )
    {
        gz.Read( buf, sizeof( buf ) );
        size_t got = gz.LastRead();

        if( got == 0 )
            break;

        out.append( buf, got );
    }

    return out;
}


nlohmann::json parseJsonOr( const std::string& aText, nlohmann::json aDefault )
{
    if( aText.empty() )
        return aDefault;

    try
    {
        return nlohmann::json::parse( aText );
    }
    catch( ... )
    {
        return aDefault;
    }
}


nlohmann::json tagsObject( const std::string& aParent, const std::string& aChild )
{
    auto list = []( const std::string& aText )
    {
        nlohmann::json v = parseJsonOr( aText, nlohmann::json::array() );
        return v.is_array() ? v : nlohmann::json::array();
    };

    return nlohmann::json{ { "parent_tag", list( aParent ) }, { "child_tag", list( aChild ) } };
}


struct ARCHIVE_CACHE
{
    wxString                                     path;
    wxDateTime                                   modified;
    wxULongLong                                  size;
    std::shared_ptr<const EASYEDAPRO::EPRJ_FILES> files;
};


std::shared_ptr<EASYEDAPRO::EPRJ_FILES> readEprj( const wxString& aFileName )
{
    SQLITE_DB handle;

    if( sqlite3_open_v2( aFileName.utf8_str(), &handle.db, SQLITE_OPEN_READONLY, nullptr ) != SQLITE_OK )
    {
        THROW_IO_ERRORF( _( "Cannot open EasyEDA Pro project database '%s': %s" ), aFileName,
                         wxString::FromUTF8( sqlite3_errmsg( handle.db ) ) );
    }

    sqlite3* db = handle.db;

    // An .eprj normally holds one project; take the first that is not archived.
    std::string projectUuid, projectName, defaultSheet, boardsText, contentText;
    int         cbbProject = 0;

    std::string projectSql = "SELECT uuid, name, content, cbb_project";
    projectSql += hasColumn( db, "projects", "boards" ) ? ", boards" : ", ''";
    projectSql += hasColumn( db, "projects", "default_sheet" ) ? ", default_sheet" : ", ''";
    projectSql += " FROM projects ORDER BY archive ASC, updated_at DESC LIMIT 1";

    forEachRow( db, projectSql,
                [&]( sqlite3_stmt* s )
                {
                    projectUuid = columnText( s, 0 );
                    projectName = columnText( s, 1 );
                    contentText = columnText( s, 2 );
                    cbbProject = sqlite3_column_int( s, 3 );
                    boardsText = columnText( s, 4 );
                    defaultSheet = columnText( s, 5 );
                } );

    if( projectUuid.empty() )
    {
        THROW_IO_ERRORF( _( "'%s' is not an EasyEDA Pro project: its database holds no project." ),
                         aFileName );
    }

    auto files = std::make_shared<EASYEDAPRO::EPRJ_FILES>();

    nlohmann::json project = {
        { "schematics", nlohmann::json::object() }, { "pcbs", nlohmann::json::object() },
        { "panels", nlohmann::json::object() },     { "symbols", nlohmann::json::object() },
        { "footprints", nlohmann::json::object() }, { "devices", nlohmann::json::object() },
        { "boards", nlohmann::json::object() },     { "config", nlohmann::json::object() }
    };

    // Schematics, with their sheets from the documents table (docType 1)
    std::map<std::string, std::string> schematicNames;

    forEachRow( db, "SELECT uuid, display_name, name FROM schematics WHERE project_uuid = '" + projectUuid + "'",
                [&]( sqlite3_stmt* s )
                {
                    std::string name = columnText( s, 1 );

                    if( name.empty() )
                        name = columnText( s, 2 );

                    schematicNames[columnText( s, 0 )] = name;
                    project["schematics"][columnText( s, 0 )] =
                            nlohmann::json{ { "name", name }, { "sheets", nlohmann::json::array() } };
                } );

    std::string docSql = "SELECT uuid, display_title, title, docType, dataStr, sheet_id, schematic_uuid FROM documents"
                         " WHERE project_uuid = '" + projectUuid + "' OR project_uuid IS NULL"
                         " ORDER BY docType, schematic_uuid, sheet_id";

    forEachRow( db, docSql,
                [&]( sqlite3_stmt* s )
                {
                    std::string uuid = columnText( s, 0 );
                    std::string title = columnText( s, 1 );

                    if( title.empty() )
                        title = columnText( s, 2 );

                    int         docType = sqlite3_column_int( s, 3 );
                    std::string data = decodeDataStr( columnText( s, 4 ) );
                    int         sheetId = sqlite3_column_int( s, 5 );
                    std::string schUuid = columnText( s, 6 );

                    if( docType == 1 ) // schematic sheet
                    {
                        if( schUuid.empty() )
                            return;

                        if( !project["schematics"].contains( schUuid ) )
                        {
                            project["schematics"][schUuid] =
                                    nlohmann::json{ { "name", schUuid }, { "sheets", nlohmann::json::array() } };
                        }

                        project["schematics"][schUuid]["sheets"].push_back(
                                nlohmann::json{ { "name", title }, { "id", sheetId }, { "uuid", uuid } } );

                        files->emplace_back( wxString::Format( wxS( "SHEET/%s/%d.esch" ),
                                                               wxString::FromUTF8( schUuid ), sheetId ),
                                             std::move( data ) );
                    }
                    else if( docType == 3 ) // board
                    {
                        project["pcbs"][uuid] = title;
                        files->emplace_back( wxS( "PCB/" ) + wxString::FromUTF8( uuid ) + wxS( ".epcb" ),
                                             std::move( data ) );
                    }
                    else if( docType == 5 ) // panel
                    {
                        project["panels"][uuid] = title;
                        files->emplace_back( wxS( "PANEL/" ) + wxString::FromUTF8( uuid ) + wxS( ".epanel" ),
                                             std::move( data ) );
                    }
                } );

    // Symbols (every component that is not a footprint) and footprints (docType 4)
    bool        hasTags = hasColumn( db, "components", "parent_tag" );
    std::string compSql = "SELECT uuid, display_title, title, description, source, version, docType, dataStr, ";
    compSql += hasTags ? "parent_tag, child_tag, custom_tags" : "'', '', ''";
    compSql += " FROM components WHERE project_uuid = '" + projectUuid + "' OR project_uuid IS NULL";

    forEachRow( db, compSql,
                [&]( sqlite3_stmt* s )
                {
                    std::string uuid = columnText( s, 0 );
                    std::string title = columnText( s, 1 );

                    if( title.empty() )
                        title = columnText( s, 2 );

                    int docType = sqlite3_column_int( s, 6 );

                    nlohmann::json entry = {
                        { "source", columnText( s, 4 ) },
                        { "desc", columnText( s, 3 ) },
                        { "tags", tagsObject( columnText( s, 8 ), columnText( s, 9 ) ) },
                        { "custom_tags", columnText( s, 10 ).empty() ? std::string( "[]" ) : columnText( s, 10 ) },
                        { "title", title },
                        { "version", columnText( s, 5 ) },
                        { "type", docType }
                    };

                    std::string data = decodeDataStr( columnText( s, 7 ) );

                    if( docType == 4 )
                    {
                        project["footprints"][uuid] = entry;
                        files->emplace_back( wxS( "FOOTPRINT/" ) + wxString::FromUTF8( uuid ) + wxS( ".efoo" ),
                                             std::move( data ) );
                    }
                    else
                    {
                        project["symbols"][uuid] = entry;
                        files->emplace_back( wxS( "SYMBOL/" ) + wxString::FromUTF8( uuid ) + wxS( ".esym" ),
                                             std::move( data ) );
                    }
                } );

    // Devices, whose attributes live in their own table
    std::map<std::string, nlohmann::json> deviceAttrs;

    forEachRow( db, "SELECT device_uuid, key, value FROM attributes",
                [&]( sqlite3_stmt* s )
                {
                    deviceAttrs[columnText( s, 0 )][columnText( s, 1 )] = columnText( s, 2 );
                } );

    bool        devTags = hasColumn( db, "devices", "parent_tag" );
    std::string devSql = "SELECT uuid, display_title, title, description, images, source, version, ";
    devSql += devTags ? "parent_tag, child_tag, custom_tags" : "'', '', ''";
    devSql += " FROM devices WHERE project_uuid = '" + projectUuid + "' OR project_uuid IS NULL";

    forEachRow( db, devSql,
                [&]( sqlite3_stmt* s )
                {
                    std::string uuid = columnText( s, 0 );
                    std::string title = columnText( s, 1 );

                    if( title.empty() )
                        title = columnText( s, 2 );

                    nlohmann::json images = nlohmann::json::array();
                    std::string    imageText = columnText( s, 4 );

                    if( !imageText.empty() )
                    {
                        nlohmann::json parsed = parseJsonOr( imageText, nlohmann::json() );
                        images = parsed.is_array() ? parsed : nlohmann::json::array( { imageText } );
                    }
                    else
                    {
                        images.push_back( "" );
                    }

                    auto attrIt = deviceAttrs.find( uuid );

                    project["devices"][uuid] = {
                        { "title", title },
                        { "attributes", attrIt != deviceAttrs.end() ? attrIt->second : nlohmann::json::object() },
                        { "description", columnText( s, 3 ) },
                        { "tags", tagsObject( columnText( s, 7 ), columnText( s, 8 ) ) },
                        { "images", images },
                        { "source", columnText( s, 5 ) },
                        { "version", columnText( s, 6 ) },
                        { "custom_tags", columnText( s, 9 ).empty() ? std::string( "[]" ) : columnText( s, 9 ) }
                    };
                } );

    // Boards: a JSON list on the project row ([{sch, name, pcb}]), older databases keep a boards table
    nlohmann::json boards = parseJsonOr( boardsText, nlohmann::json::array() );

    if( boards.is_array() )
    {
        for( const nlohmann::json& b : boards )
        {
            if( !b.is_object() || !b.contains( "name" ) || !b.at( "name" ).is_string() )
                continue;

            project["boards"][b.at( "name" ).get<std::string>()] = {
                { "schematic", b.value( "sch", std::string() ) }, { "pcb", b.value( "pcb", std::string() ) }
            };
        }
    }

    if( project["boards"].empty() )
    {
        forEachRow( db, "SELECT name, sch_uuid FROM boards WHERE project_uuid = '" + projectUuid + "' ORDER BY sort",
                    [&]( sqlite3_stmt* s )
                    {
                        project["boards"][columnText( s, 0 )] = { { "schematic", columnText( s, 1 ) },
                                                                 { "pcb", std::string() } };
                    } );
    }

    // Copper pours computed by the editor (the .epro's POUR/*.ecop files)
    forEachRow( db, "SELECT path, dataStr FROM coppers WHERE project_uuid = '" + projectUuid + "'",
                [&]( sqlite3_stmt* s )
                {
                    wxString path = wxString::FromUTF8( columnText( s, 0 ) );

                    if( !path.EndsWith( wxS( ".ecop" ) ) )
                        path += wxS( ".ecop" );

                    files->emplace_back( wxS( "POUR/" ) + path.AfterLast( '/' ), decodeDataStr( columnText( s, 1 ) ) );
                } );

    // Images and other embedded files; the .epro names them by the base64 of their hash
    forEachRow( db, "SELECT hash, dataStr FROM resources",
                [&]( sqlite3_stmt* s )
                {
                    std::string hash = columnText( s, 0 );
                    wxString    name = wxBase64Encode( hash.data(), hash.size() );
                    files->emplace_back( wxS( "BLOB/" ) + name + wxS( ".eblob" ), decodeDataStr( columnText( s, 1 ) ) );
                } );

    nlohmann::json content = parseJsonOr( contentText, nlohmann::json::object() );
    std::string    editorVersion;

    forEachRow( db, "SELECT value FROM db_versions WHERE key = 'sqlite'",
                [&]( sqlite3_stmt* s ) { editorVersion = columnText( s, 0 ); } );

    project["config"] = { { "title", projectName },
                          { "cbbProject", cbbProject },
                          { "defaultSheet", defaultSheet },
                          { "editorVersion", editorVersion } };

    if( content.is_object() )
    {
        for( const auto& [key, value] : content.items() )
        {
            if( !project["config"].contains( key ) )
                project["config"][key] = value;
        }
    }

    files->emplace( files->begin(), wxS( "project.json" ), project.dump() );

    return files;
}

} // namespace


bool EASYEDAPRO::IsEprjFile( const wxString& aFileName )
{
    wxFFile file( aFileName, wxS( "rb" ) );

    if( !file.IsOpened() )
        return false;

    char header[16] = {};

    if( file.Read( header, sizeof( header ) ) != sizeof( header ) )
        return false;

    if( memcmp( header, "SQLite format 3\0", 16 ) != 0 )
        return false;

    // EasyEDA Pro's databases (projects and libraries) all have these tables
    file.Close();

    SQLITE_DB handle;

    if( sqlite3_open_v2( aFileName.utf8_str(), &handle.db, SQLITE_OPEN_READONLY, nullptr ) != SQLITE_OK )
        return false;

    int found = 0;

    forEachRow( handle.db,
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('projects', 'documents', "
                "'components', 'devices')",
                [&]( sqlite3_stmt* s ) { found = sqlite3_column_int( s, 0 ); } );

    return found == 4;
}


std::shared_ptr<const EASYEDAPRO::EPRJ_FILES> EASYEDAPRO::ReadEprjFiles( const wxString& aFileName )
{
    // The importers walk the archive several times per load (index, libraries, each document), so the decoded
    // database is kept while the file is unchanged.
    static std::mutex    s_mutex;
    static ARCHIVE_CACHE s_cache;

    wxFileName  fn( aFileName );
    wxDateTime  modified = fn.GetModificationTime();
    wxULongLong size = fn.GetSize();

    std::lock_guard<std::mutex> lock( s_mutex );

    if( s_cache.files && s_cache.path == fn.GetFullPath() && s_cache.modified == modified && s_cache.size == size )
        return s_cache.files;

    std::shared_ptr<const EPRJ_FILES> files = readEprj( aFileName );

    s_cache.path = fn.GetFullPath();
    s_cache.modified = modified;
    s_cache.size = size;
    s_cache.files = files;

    return files;
}
