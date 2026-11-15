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

#ifndef COLLAB_STDLIBS_H
#define COLLAB_STDLIBS_H

#include <functional>

#include <wx/string.h>

#include <kicommon.h>

/**
 * The standard KiCad symbol and footprint libraries, downloaded by Junction itself.
 *
 * Junction ships without them and borrows an installed KiCad's copy.  On a computer with no
 * KiCad there is nothing to borrow, so the libraries are fetched from the KiCad library
 * repositories into PATHS::GetManagedLibrariesPath() and used from there.  3D models are not
 * part of this: they are fetched one by one when a board needs them.
 */
namespace COLLAB_STDLIBS
{

/// Called from the worker with a message and a percentage (-1 when unknown).  Returning false
/// stops the download.
using PROGRESS = std::function<bool( const wxString& aMessage, int aPercent )>;

/// @return true when no standard libraries are found anywhere, so a download would help.
KICOMMON_API bool Needed();

/// @return true when the user said not to ask again.
KICOMMON_API bool Declined();

KICOMMON_API void SetDeclined( bool aDeclined );

/**
 * Download and unpack the libraries.  Blocks; run it on a worker thread.
 *
 * Nothing the running program uses is touched until the very end, when the finished folders
 * are moved into place, so a stopped or failed download leaves no half library behind.
 *
 * @return true when the libraries are in place.  @p aError says what went wrong otherwise.
 */
KICOMMON_API bool Install( const PROGRESS& aProgress, wxString* aError );

/**
 * Start using freshly installed libraries without a restart: point the library path variables
 * at them and set up the global library tables that were created empty for lack of libraries.
 * Call on the main thread.
 */
KICOMMON_API void Activate();

} // namespace COLLAB_STDLIBS

#endif // COLLAB_STDLIBS_H
