/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#pragma once

#include <memory>

#include <lib_id.h>
#include <nlohmann/json.hpp>
#include <wx/string.h>

class LIB_SYMBOL;
class PROJECT;


/**
 * Vendor parts (LCSC, Mouser, DigiKey) in the desktop Choose Symbol dialog, as the web editor has
 * them: the collaboration server searches the vendors and converts a part's drawings to a KiCad
 * symbol and footprint (GET /api/parts/search, /api/parts/part).  A part someone picks is kept in
 * the project, in the library the server names it in ("LCSC", beside the project in the
 * collaboration library folder), so the schematic and the board find it like any other part.
 */
namespace SCH_VENDOR_PARTS
{

/// The nickname of the project's vendor part library: the server's "LCSC", or "Junction_LCSC"
/// when the project already uses "LCSC" for a library of its own.
wxString LibraryNickname( PROJECT& aProject );

/**
 * The part's symbol, ready to keep in the vendor library: its drawing (a KiCad standard symbol
 * for passives with no vendor drawing), named for the part, with the footprint, value, datasheet,
 * description and vendor fields (LCSC, MPN, Manufacturer, ...) of the listing.
 *
 * @param aPart a GET /api/parts/part answer asked for with lib=aNickname.
 */
std::unique_ptr<LIB_SYMBOL> SymbolFromPart( const nlohmann::json& aPart, const wxString& aNickname,
                                            wxString& aError );

/**
 * Keep the part in the project: the symbol in <project>/<collab libs>/<nick>.kicad_sym, the
 * footprint (when the vendor has one) in <nick>.pretty, both libraries in the project's tables.
 *
 * @return the symbol's LIB_ID, or an invalid one with aError saying why.
 */
LIB_ID Install( PROJECT& aProject, const nlohmann::json& aPart, const wxString& aNickname,
                wxString& aError );

/// One line for a search result: "C8734  STM32F103C8T6  STMicroelectronics".
wxString ResultTitle( const nlohmann::json& aResult );

} // namespace SCH_VENDOR_PARTS
